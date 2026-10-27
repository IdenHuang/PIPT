import os, tempfile, logging, uuid
from io import BytesIO
from typing import List
import boto3, pymupdf

from langchain_postgres import PGVector
from langchain_core.documents import Document
from langchain_aws import BedrockEmbeddings
from langchain_experimental.text_splitter import SemanticChunker
from langchain_classic.indexes import SQLRecordManager, index

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize the S3 client
s3 = boto3.client('s3')

EMBEDDING_BUCKET_NAME = os.environ["EMBEDDING_BUCKET_NAME"]

# Folders whose files are embedded into the persona's collection. The student
# chat retrieves from that collection, so instructor-only folders (answer_key)
# must never be listed here. The debrief reads answer keys from S3 directly.
EMBEDDED_FOLDERS = ("documents", "info")

def extract_txt(
    bucket: str, 
    file_key: str
) -> str:
    """
    Extract text from a file stored in an S3 bucket.
    
    Args:
    bucket (str): The name of the S3 bucket.
    file_key (str): The key of the file in the S3 bucket.
    
    Returns:
    str: The extracted text.
    """
    with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
        s3.download_fileobj(bucket, file_key, tmp_file)
        tmp_file_path = tmp_file.name

    try:
        with open(tmp_file_path, 'r', encoding='utf-8') as file:
            text = file.read()
    finally:
        os.remove(tmp_file_path)

    return text

def get_ingestion_status(persona_id: str, file_path: str, connection) -> str:
    """
    Retrieves the current ingestion status of a file.
    
    Args:
        persona_id (str): The persona ID associated with the file.
        file_path (str): The full file path stored in the database.
    
    Returns:
        str: The current ingestion status ("completed", "processing", "error", or None).
    """
    if connection is None:
        logger.error("Database connection failed. Unable to retrieve ingestion status.")
        return None

    try:
        cur = connection.cursor()

        select_query = "SELECT ingestion_status FROM persona_data WHERE persona_id = %s AND filepath = %s;"

        cur.execute(select_query, (persona_id, file_path))
        result = cur.fetchone()
        connection.commit()
        cur.close()
        return result[0] if result else None

    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.error(f"Error retrieving ingestion status for {file_path}: {e}")
        return None

def update_ingestion_status(persona_id: str, file_path: str, status: str, connection):
    """
    Updates the ingestion_status of a file in the persona_data table.

    Args:
        persona_id (str): The persona ID associated with the file.
        file_path (str): The full file path stored in the database.
        status (str): The status to update ('completed' or 'error').
    """
    if connection is None:
        logger.error("Database connection failed. Unable to update ingestion status.")
        return

    try:
        cur = connection.cursor()

        # Retrieve the current ingestion status
        select_query = "SELECT ingestion_status FROM persona_data WHERE persona_id = %s AND filepath = %s;"
        cur.execute(select_query, (persona_id, file_path))
        result = cur.fetchone()

        if result and result[0] == "completed":
            logger.info(f"Ingestion status for {file_path} is already 'completed'. Skipping update.")
            connection.commit()
            cur.close()
            return

        update_query = """
        UPDATE "persona_data"
        SET ingestion_status = %s
        WHERE persona_id = %s
        AND filepath = %s;
        """
        cur.execute(update_query, (status, persona_id, file_path))
        connection.commit()
        cur.close()

        logger.info(f"Ingestion status for {file_path} updated to '{status}' for persona {persona_id}.")

    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.error(f"Error updating ingestion status for persona {persona_id}, file {file_path}: {e}")
        raise

def store_doc_texts(
    bucket: str, 
    group: str, 
    persona: str,
    filename: str, 
    output_bucket: str,
    folder: str = "documents"
) -> List[str]:
    """
    Store the text of each page of a document in an S3 bucket.
    
    Args:
    bucket (str): The name of the S3 bucket containing the document.
    group (str): The group ID folder in the S3 bucket.
    persona (str): The persona name and ID folder within the group.
    filename (str): The name of the document file.
    output_bucket (str): The name of the S3 bucket for storing the extracted text.
    folder (str): The folder category (e.g. "documents", "info", "answer_key").
    
    Returns:
    List[str]: A list of keys for the stored text files in the output bucket.
    """
    with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
        s3.download_file(bucket, f"{group}/{persona}/{folder}/{filename}", tmp_file.name)
        file_name, file_type = filename.rsplit('.', 1)
        doc = pymupdf.open(tmp_file.name, filetype=file_type)
        
        with BytesIO() as output_buffer:
            for page_num, page in enumerate(doc, start=1):
                text = page.get_text().encode("utf8")
                output_buffer.write(text)
                output_buffer.write(bytes((12,)))
                
                page_output_key = f'{group}/{persona}/{folder}/{filename}_page_{page_num}.txt'
                
                with BytesIO(text) as page_output_buffer:
                    s3.upload_fileobj(page_output_buffer, output_bucket, page_output_key)

        os.remove(tmp_file.name)

    return [f'{group}/{persona}/{folder}/{filename}_page_{page_num}.txt' for page_num in range(1, len(doc) + 1)]

def add_document(
    bucket: str, 
    group: str, 
    persona: str,
    filename: str, 
    vectorstore: PGVector, 
    embeddings: BedrockEmbeddings,
    output_bucket: str = EMBEDDING_BUCKET_NAME,
    folder: str = "documents"
) -> List[Document]:
    """
    Add a document to the vectorstore.
    
    Args:
    bucket (str): The name of the S3 bucket containing the document.
    group (str): The group ID folder in the S3 bucket.
    persona (str): The persona name and ID folder within the group.
    filename (str): The name of the document file.
    vectorstore (PGVector): The vectorstore instance.
    embeddings (BedrockEmbeddings): The embeddings instance.
    output_bucket (str, optional): The name of the S3 bucket for storing extracted data. Defaults to 'temp-extracted-data'.
    folder (str): The folder category (e.g. "documents", "info", "answer_key").
    
    Returns:
    List[Document]: A list of all document chunks for this document that were added to the vectorstore.
    """
    
    output_filenames = store_doc_texts(
        bucket=bucket,
        group=group,
        persona=persona,
        filename=filename,
        output_bucket=output_bucket,
        folder=folder
    )
    this_doc_chunks = store_doc_chunks(
        bucket=output_bucket,
        filenames=output_filenames,
        vectorstore=vectorstore,
        embeddings=embeddings,
        # The document's identity is its original object key, passed explicitly.
        # It must not be re-derived from the per-page temp keys: a filename that
        # itself contains "_page" would otherwise collide with another document's
        # source id, and incremental cleanup would delete that document's embeddings.
        source_key=f"{group}/{persona}/{folder}/{filename}",
    )
    
    return this_doc_chunks

def store_doc_chunks(
    bucket: str, 
    filenames: List[str],
    vectorstore: PGVector, 
    embeddings: BedrockEmbeddings,
    source_key: str,
) -> List[Document]:
    """
    Store chunks of documents in the vectorstore.
    
    Args:
    bucket (str): The name of the S3 bucket containing the text files.
    filenames (List[str]): A list of keys for the text files in the bucket.
    vectorstore (PGVector): The vectorstore instance.
    embeddings (BedrockEmbeddings): The embeddings instance.
    source_key (str): Key of the original uploaded document
        ({group}/{persona}/{folder}/{filename}). Every chunk's "source" metadata
        is s3://{bucket}/{source_key}; this is the source_id_key used by
        index() incremental cleanup, so it must uniquely identify one upload.
    
    Returns:
    List[Document]: A list of all document chunks for this document that were added to the vectorstore.
    """
    text_splitter = SemanticChunker(embeddings)
    this_doc_chunks = []

    for filename in filenames:
        this_uuid = str(uuid.uuid4()) # Generating one UUID for all chunks of from a specific page in the document
        output_buffer = BytesIO()
        s3.download_fileobj(bucket, filename, output_buffer)
        output_buffer.seek(0)
        doc_texts = output_buffer.read().decode('utf-8')
        doc_chunks = text_splitter.create_documents([doc_texts])
        
        doc_chunks = [x for x in doc_chunks if x.page_content]
        
        for doc_chunk in doc_chunks:
            if doc_chunk:
                doc_chunk.metadata["source"] = f"s3://{bucket}/{source_key}"
                doc_chunk.metadata["doc_id"] = this_uuid
                
            else:
                logger.warning(f"Empty chunk for {filename}")
        
        s3.delete_object(Bucket=bucket, Key=filename)
        
        this_doc_chunks.extend(doc_chunks)
       
    return this_doc_chunks
                
def purge_answer_key_embeddings(persona_id: str, connection) -> int:
    """
    Delete answer-key chunks from a persona's collection.

    Earlier versions embedded the answer_key folder into the same collection
    the student chat retrieves from. This removes those chunks so they stop
    being retrievable. Matching uses the same source format store_doc_chunks
    writes: s3://{bucket}/{group}/{persona}/answer_key/{file}.

    Returns the number of rows deleted (0 on error, which is logged).
    """
    if connection is None:
        logger.error("Database connection failed. Unable to purge answer-key embeddings.")
        return 0

    cur = None
    try:
        cur = connection.cursor()
        cur.execute(
            """
            DELETE FROM langchain_pg_embedding e
            USING langchain_pg_collection c
            WHERE e.collection_id = c.uuid
              AND c.name = %s
              AND e.cmetadata->>'source' LIKE %s
            """,
            (persona_id, f"%/{persona_id}/answer_key/%"),
        )
        deleted = cur.rowcount
        connection.commit()
        cur.close()
        if deleted:
            logger.info(f"Purged {deleted} answer-key embeddings from persona {persona_id}.")
        return deleted
    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.error(f"Error purging answer-key embeddings for persona {persona_id}: {e}")
        return 0

def process_documents(
    bucket: str, 
    group: str, 
    persona_id: str, 
    vectorstore: PGVector, 
    embeddings: BedrockEmbeddings,
    record_manager: SQLRecordManager,
    connection
) -> None:
    """
    Process and add text documents from an S3 bucket to the vectorstore.
    
    Args:
    bucket (str): The name of the S3 bucket containing the text documents.
    group (str): The group ID folder in the S3 bucket.
    vectorstore (PGVector): The vectorstore instance.
    embeddings (BedrockEmbeddings): The embeddings instance.
    record_manager (SQLRecordManager): Manages list of documents in the vectorstore for indexing.
    """
    # Remove answer-key chunks that earlier versions embedded here.
    purge_answer_key_embeddings(persona_id, connection)

    folders = EMBEDDED_FOLDERS
    all_doc_chunks = []
    # Files are marked "completed" only after index() has written their
    # embeddings. Marking them earlier meant a failure inside index() left
    # them "completed" with no embeddings, and later runs skipped them.
    processed_file_paths = []
    
    for folder in folders:
        paginator = s3.get_paginator('list_objects_v2')
        page_iterator = paginator.paginate(Bucket=bucket, Prefix=f"{group}/{persona_id}/{folder}")
        
        for page in page_iterator:
            if "Contents" not in page:
                continue  # Skip pages without any content (e.g., if the bucket is empty)
            for file in page['Contents']:
                filename = file['Key']
                if filename.endswith((".pdf", ".docx", ".pptx", ".txt", ".xlsx", ".xps", ".mobi", ".cbz")):
                    file_path = f"{group}/{persona_id}/{folder}/{os.path.basename(filename)}"
                    this_doc_chunks = []
                    print(file_path)

                    # Check if ingestion has already been completed
                    current_status = get_ingestion_status(persona_id, file_path, connection)
                    if current_status == "completed":
                        logger.info(f"Ingestion already completed for {file_path}, skipping update.")
                        continue
                    
                    this_doc_chunks = add_document(
                        bucket=bucket,
                        group=group,
                        persona=persona_id,
                        filename=os.path.basename(filename),
                        vectorstore=vectorstore,
                        embeddings=embeddings,
                        folder=folder
                    )

                    all_doc_chunks.extend(this_doc_chunks)
                    processed_file_paths.append(file_path)
    
    if all_doc_chunks:  # Check if there are any documents to index
        # If this raises, no file is marked "completed", so they are all
        # re-derived from the original upload on the next run.
        idx = index(
            all_doc_chunks, 
            record_manager, 
            vectorstore, 
            cleanup="incremental",
            source_id_key="source"
        )
        logger.info(f"Indexing updates: \n {idx}")
    else:
        logger.info("No documents found for indexing.")

    for file_path in processed_file_paths:
        update_ingestion_status(persona_id, file_path, "completed", connection)