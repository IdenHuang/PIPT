from typing import Dict

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_classic.chains import create_history_aware_retriever

from helpers.helper import get_vectorstore

# Persona folders whose chunks the student-facing chat may retrieve. Must match
# the folder segment of cmetadata["source"] written by data ingestion:
# s3://{bucket}/{group}/{persona}/{folder}/{file}
STUDENT_RETRIEVABLE_FOLDERS = ("documents", "info")


def student_safe_source_filter(persona_id: str) -> Dict:
    """
    Build a PGVector metadata filter that matches only chunks whose source is
    in one of STUDENT_RETRIEVABLE_FOLDERS for this persona.

    Uses langchain-postgres JSONB filter syntax ($or / $like).
    https://python.langchain.com/docs/integrations/vectorstores/pgvector/#filtering-support
    """
    return {
        "$or": [
            {"source": {"$like": f"%/{persona_id}/{folder}/%"}}
            for folder in STUDENT_RETRIEVABLE_FOLDERS
        ]
    }


def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict: Dict[str, str],
    embeddings#: BedrockEmbeddings
) -> object:
    """
    Retrieve the vectorstore and return the history-aware retriever object.

    Args:
    llm: The language model instance used to generate the response.
    vectorstore_config_dict (Dict[str, str]): The configuration dictionary for the vectorstore, including parameters like collection name, database name, user, password, host, and port.
    embeddings (BedrockEmbeddings): The embeddings instance used to process the documents.

    Returns:
    VectorStoreRetriever: A history-aware retriever instance.
    """
    vectorstore, _ = get_vectorstore(
        collection_name=vectorstore_config_dict['collection_name'],
        embeddings=embeddings,
        dbname=vectorstore_config_dict['dbname'],
        user=vectorstore_config_dict['user'],
        password=vectorstore_config_dict['password'],
        host=vectorstore_config_dict['host'],
        port=int(vectorstore_config_dict['port'])
    )

    # Only retrieve chunks from student-safe folders. The collection may still
    # hold answer_key chunks embedded by earlier ingestion versions, and those
    # must never reach the patient prompt. Allowlisting (rather than excluding
    # answer_key) keeps any future instructor-only folder out by default.
    retriever = vectorstore.as_retriever(
        search_kwargs={"filter": student_safe_source_filter(vectorstore_config_dict['collection_name'])}
    )

    # Contextualize question and create history-aware retriever
    contextualize_q_system_prompt = (
        "Given a chat history and the latest user question "
        "which might reference context in the chat history, "
        "formulate a standalone question which can be understood "
        "without the chat history. Do NOT answer the question, "
        "just reformulate it if needed and otherwise return it as is."
    )
    contextualize_q_prompt = ChatPromptTemplate.from_messages(
        [
            ("system", contextualize_q_system_prompt),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )
    history_aware_retriever = create_history_aware_retriever(
        llm, retriever, contextualize_q_prompt
    )

    return history_aware_retriever