import io
import os
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from markitdown import MarkItDown
from pydantic import BaseModel
import markdown
import weasyprint
import docx
import htmldocx

app = FastAPI(title="reporting-agent converter")
md = MarkItDown(enable_plugins=False)

# Minimal CSS for readable PDF output (no external dependencies)
_BASE_CSS = """
body {
    font-family: DejaVu Sans, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    margin: 2.5cm 2.5cm 2.5cm 2.5cm;
    color: #1a1a1a;
}
h1 { font-size: 20pt; margin-top: 1.4em; margin-bottom: 0.4em; }
h2 { font-size: 15pt; margin-top: 1.2em; margin-bottom: 0.3em; }
h3 { font-size: 12pt; margin-top: 1em; margin-bottom: 0.2em; }
h4, h5, h6 { font-size: 11pt; margin-top: 0.8em; margin-bottom: 0.2em; }
p  { margin: 0.5em 0; }
pre, code {
    font-family: DejaVu Sans Mono, Courier New, monospace;
    font-size: 9pt;
    background: #f5f5f5;
    border-radius: 3px;
    padding: 0.1em 0.3em;
}
pre { padding: 0.6em 0.8em; overflow-x: auto; }
table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.8em 0;
    font-size: 10pt;
}
th, td {
    border: 1px solid #aaa;
    padding: 0.35em 0.6em;
    text-align: left;
}
th { background: #e8e8e8; font-weight: bold; }
tr:nth-child(even) { background: #f9f9f9; }
blockquote {
    border-left: 3px solid #ccc;
    margin: 0.5em 0 0.5em 1em;
    padding: 0.2em 0.8em;
    color: #555;
}
ul, ol { margin: 0.4em 0; padding-left: 1.6em; }
li { margin: 0.2em 0; }
a { color: #1a5276; }
"""

_MD_EXTENSIONS = ["tables", "fenced_code", "sane_lists", "toc"]


def _markdown_to_html(md_text: str) -> str:
    body = markdown.markdown(md_text, extensions=_MD_EXTENSIONS)
    return (
        "<!DOCTYPE html><html><head>"
        '<meta charset="utf-8">'
        f"<style>{_BASE_CSS}</style>"
        f"</head><body>{body}</body></html>"
    )


class RenderRequest(BaseModel):
    markdown: str
    format: str  # "pdf" | "docx"


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/convert")
async def convert(file: UploadFile = File(...)):
    data = await file.read()
    ext = os.path.splitext(file.filename or "")[1].lower()
    try:
        result = md.convert_stream(io.BytesIO(data), file_extension=ext)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"conversion failed: {exc}")
    return {"filename": file.filename, "markdown": result.text_content}


@app.post("/render")
async def render(req: RenderRequest):
    """
    Render Markdown to PDF or DOCX.

    Request body (JSON):
        { "markdown": "<markdown string>", "format": "pdf" | "docx" }

    Response:
        - PDF:  Content-Type application/pdf, binary body
        - DOCX: Content-Type application/vnd.openxmlformats-officedocument
                         .wordprocessingml.document, binary body
        - 400 on unknown format
    """
    fmt = req.format.lower()
    if fmt not in ("pdf", "docx"):
        raise HTTPException(status_code=400, detail=f"unknown format '{req.format}'; use 'pdf' or 'docx'")

    html = _markdown_to_html(req.markdown)

    if fmt == "pdf":
        try:
            pdf_bytes = weasyprint.HTML(string=html).write_pdf()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"PDF rendering failed: {exc}")
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
        )

    # docx
    try:
        document = docx.Document()
        h2d = htmldocx.HtmlToDocx()
        h2d.add_html_to_document(html, document)
        buf = io.BytesIO()
        document.save(buf)
        docx_bytes = buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"DOCX rendering failed: {exc}")
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
