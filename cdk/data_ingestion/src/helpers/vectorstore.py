from helpers.helper import store_group_data

def update_vectorstore(
    bucket: str,
    group: str,
    persona_id: str,
    vectorstore,#: PGVector
    record_manager,#: SQLRecordManager
    embeddings,#: BedrockEmbeddings
    connection
) -> None:
    """
    Update the vectorstore with embeddings for all documents and images in the S3 bucket.

    Args:
    bucket (str): The name of the S3 bucket containing the group folders.
    group (str): The name of the group folder within the S3 bucket.
    vectorstore (PGVector): The vectorstore opened by helpers.helper.open_vectorstore().
    record_manager (SQLRecordManager): The record manager opened alongside the vectorstore.
    embeddings (BedrockEmbeddings): The embeddings instance used to process the documents and images.

    Returns:
    None
    """
    store_group_data(
        bucket=bucket,
        group=group,
        persona_id=persona_id,
        vectorstore=vectorstore,
        record_manager=record_manager,
        embeddings=embeddings,
        connection=connection
    )
