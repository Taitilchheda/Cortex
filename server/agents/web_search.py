import httpx
from typing import List, Dict, Any, AsyncGenerator
from duckduckgo_search import DDGS

async def search_web(query: str, limit: int = 3) -> List[Dict[str, str]]:
    """
    Search DDG for live snippets. Free, privacy-first, no API key required.
    """
    results = []
    try:
        with DDGS() as ddgs:
            # Sync wrapper for now (DDGS is blocking)
            search_results = list(ddgs.text(query, max_results=limit))
            for r in search_results:
                results.append({
                    "title": r.get("title", ""),
                    "href": r.get("href", ""),
                    "body": r.get("body", "")
                })
        return results
    except Exception as e:
        print(f"Web Search Error: {str(e)}")
        return []

async def get_web_context(query: str) -> str:
    """
    Helper for agents to call to get a text summary.
    """
    results = await search_web(query)
    if not results:
        return ""
        
    context = "\n--- Web Search Wisdom (Relevant Snippets) ---\n"
    for r in results:
        context += f"Source: {r['href']}\nSnippet: {r['body']}\n\n"
    return context + "--- End Web context ---\n"
