# Document parser fixtures

These small synthetic documents contain no user data. They are committed so the
tests run without a document editor, PDF generator or network access.

- `two-pages.pdf`: two pages with Chinese and English text. Weather and umbrella
  content is on page 1; database/index/search content is on page 2.
- `paragraphs.docx`: three paragraphs with the same two topics plus Unicode and
  XML-sensitive characters (`😀 & <original>`).
- `empty.pdf` and `empty.docx`: valid documents with no searchable text.

Regenerate them from `apps/api` with Node.js 24:

```powershell
node test/fixtures/generate-documents.mjs
```

The generator uses PDF objects and an uncompressed OpenXML ZIP container. Both are
read by the real parser libraries in the tests. The PDFs use a predefined Chinese
CMap to exercise the bundled PDF.js font/CMap assets on Windows and Linux.
