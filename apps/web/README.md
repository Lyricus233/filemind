# FileMind Web

The search workbench is the home page (`/`). Links to `/preview` redirect to the
home page with their search parameters intact. The file library supports
uploading TXT, Markdown, PDF, and DOCX files. Open a file to start processing,
follow its status, inspect the extracted passages, or download the original.

Use Node.js 24 and pnpm. Start the API, worker, and their backing services as
described in [Semantic retrieval](../../docs/semantic-search.md). Then run these
commands from this directory.

```powershell
pnpm install
pnpm dev
```

Open the local URL printed by Vite. The development and preview servers forward
`/api` to `http://127.0.0.1:3000`. If the API uses another port, set
`FILEMIND_API_TARGET` in a local `.env` file or in the shell before starting Vite.

Upload [the sample PDF](../api/test/fixtures/two-pages.pdf) and start processing it.
After it is indexed, search for `数据库索引` in keyword mode. The matching text is
highlighted and the result points to page 2. Select a result to inspect its source
chunk, or use `打开文件详情` to open it in the file detail page. Semantic mode
displays the returned cosine scores, model, and vector dimensions.

Add two to four results to **向量对比** to see their pairwise cosine similarity
using the full chunk vectors. Results from different vector spaces have an
empty score. The static demo offers the same comparison with its sample vectors.

`pnpm build` typechecks the app and produces `dist`. When serving that output,
configure the host to serve `index.html` for client routes and forward `/api` to
the API with the prefix removed.

## Static demo

`pnpm dev:demo` opens the public demo locally. `pnpm build:demo` builds the same
workbench into `dist` with bundled sample documents and hash-based routing, so a
static host can serve the output directly.

Visitors can run arbitrary keyword searches, filter the sample library, open
passages and download the sample originals. The vector inspector previews the
first 32 dimensions of a 64-dimensional vector computed from adjacent characters
in each sample passage. Visitors can copy the full vector. Semantic search
demonstrates a preset query and curated results. The demo runs in the browser
and has no API or credentials to configure.
