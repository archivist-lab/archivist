# Museum Intelligence: The Archivist V2 AI & Discovery Engine

> **Architect's Foreword:**
> In V1, "Discovery" was a passive process—users manually browsed trending lists from Trakt or IMDb. In V2, the Museum gains a **Brain**. By utilizing local vector embeddings and large language models (LLMs), Archivist transitions from a reactive manager to a proactive curator that understands the "vibe" and semantic relationships between different media types.

---

## 1. Core Architecture: The Semantic Vector Vault

Archivist V2 does not just store metadata; it stores **Meanings**.

### 1.1. The Embedding Pipeline
- **Local Inference:** All embeddings are generated locally using **Ollama** or **ONNX Runtime** to ensure absolute user privacy.
- **Model Selection:** 
  - **Text:** `all-MiniLM-L6-v2` (384-dim) for fast, low-memory indexing of overviews and tags.
  - **Visual:** `CLIP` (Contrastive Language-Image Pretraining) for embedding posters, fanart, and book covers, enabling "search by visual style."
- **Entity Merging:** The engine combines metadata from all departments (Film, TV, Music, Books, Games) into a unified **Semantic Space**.

### 1.2. The Vector Database
- **Implementation:** **ChromaDB** (embedded) for local development; **Qdrant** or **pgvector** for enterprise/distributed deployments.
- **Filtering:** High-performance HNSW (Hierarchical Navigable Small World) indexing allowing for sub-10ms similarity searches across 100k+ entities.

---

## 2. Discovery Modules

### 2.1. Cross-Domain Recommendations (The "Mega-App" Advantage)
Because Archivist understands the entire media ecosystem, it can offer insights that standalone apps cannot:
- **Adaptation Tracking:** "You just added the *Dune* audiobook; would you like me to monitor the 1984 film, the 2021 film, and the tabletop RPG?"
- **The "Vibe" Shift:** "You've been listening to dark synthwave; here are some Cyberpunk novels and Neo-Noir films that match that aesthetic."

### 2.2. Semantic Search
Moving beyond keyword matching to **Intent Matching**:
- **Natural Language Queries:** Users can search for "Movies where a group of friends go to a cabin and things go wrong" or "Books about stoic philosophy but for beginners."
- **Visual Search:** "Find me comics with an art style similar to this cover."

### 2.3. AI-Driven "Weekly Pull" (Comics/Manga)
- **Speculative Suggestions:** Analyzing current pull lists to suggest new series based on artist, writer, or narrative tropes, rather than just "People who liked X also liked Y."

---

## 3. The LLM Curator (Experimental)

### 3.1. Natural Language Interface
- **The Librarian:** A chat interface (Discord/Web) that acts as a front-door to the library.
- **Automated Summarization:** Generating "The Story So Far" summaries for TV series or long-running comic arcs.

### 3.2. Conflict Resolution
- **Intelligent Deduplication:** Using LLMs to determine if two differently-named releases are actually the same artifact (e.g., "Director's Cut" vs "Ultimate Edition" with different file structures).

---

## 4. Privacy & Performance Standards

- **Zero-Cloud Guarantee:** No metadata, watch history, or embeddings are ever transmitted to external AI providers.
- **Resource Throttling:** Background indexing is pinned to low-priority threads and utilizes NPU/GPU acceleration only when the system is idle.
- **Data Redaction:** The engine automatically scrubs PII (Personal Identifiable Information) before generating embeddings.
