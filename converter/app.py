import io
import os
import re
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

# Maximum upload size: default 50 MB, overridable via MAX_UPLOAD_BYTES env var.
_MAX_UPLOAD_BYTES: int = int(os.environ.get("MAX_UPLOAD_BYTES", 50_000_000))


def _ssrf_safe_url_fetcher(url: str, timeout: int = 10):
    """
    WeasyPrint url_fetcher that blocks all non-data URLs to prevent SSRF.

    User-controlled Markdown may contain <img src="http://internal-host/...">
    or similar. Without this guard, WeasyPrint would fetch those URLs from
    inside the container, potentially reaching internal services.

    We allow only data: URIs (inline base64 images). All http/https/file URLs
    are blocked. This means external images will not render in PDFs, which is
    an acceptable trade-off for a compliance document converter.
    """
    if url.startswith("data:"):
        # Let WeasyPrint handle data URIs natively via its default fetcher.
        return weasyprint.default_url_fetcher(url)
    raise ValueError(
        f"Blocked external URL in document rendering (SSRF prevention): {url!r}. "
        "Only data: URIs are allowed in rendered documents."
    )

# CSS for PDF/DOCX output — A4, page numbers, section breaks, WeasyPrint paged media
_BASE_CSS = """
@page {
    size: A4 portrait;
    margin: 2.5cm 2.5cm 3cm 2.5cm;
    @bottom-right {
        content: "Page " counter(page) " of " counter(pages);
        font-size: 8pt;
        color: #888;
        font-family: DejaVu Sans, Arial, sans-serif;
    }
}

body {
    font-family: DejaVu Sans, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.6;
    color: #1a1a1a;
    orphans: 3;
    widows: 3;
}

h1 {
    font-size: 18pt;
    margin-top: 1.6em;
    margin-bottom: 0.5em;
    break-before: page;
    break-after: avoid;
    color: #1a3a5c;
    border-bottom: 2px solid #1a3a5c;
    padding-bottom: 0.2em;
}
/* Don't insert a blank page before the very first heading */
h1:first-child { break-before: avoid; }

h2 {
    font-size: 13pt;
    margin-top: 1.3em;
    margin-bottom: 0.4em;
    break-after: avoid;
    color: #1a3a5c;
}
h3 {
    font-size: 11pt;
    margin-top: 1em;
    margin-bottom: 0.3em;
    break-after: avoid;
}
h4, h5, h6 {
    font-size: 10.5pt;
    margin-top: 0.8em;
    margin-bottom: 0.2em;
    break-after: avoid;
}

p { margin: 0.5em 0; }

pre, code {
    font-family: DejaVu Sans Mono, Courier New, monospace;
    font-size: 8.5pt;
    background: #f4f4f4;
    border-radius: 3px;
    padding: 0.1em 0.3em;
}
pre {
    padding: 0.6em 0.8em;
    /* overflow-x: auto has no effect in PDF — wrap instead */
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
    break-inside: avoid;
}

table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.8em 0;
    font-size: 9.5pt;
    break-inside: auto;
}
thead { display: table-header-group; } /* repeat header on each page */
th, td {
    border: 1px solid #b0b0b0;
    padding: 0.35em 0.65em;
    text-align: left;
    vertical-align: top;
}
th {
    background: #dce6f0;
    font-weight: bold;
    color: #1a3a5c;
}
tr { break-inside: avoid; }
tr:nth-child(even) { background: #f5f8fb; }

blockquote {
    border-left: 3px solid #1a3a5c;
    margin: 0.5em 0 0.5em 1em;
    padding: 0.3em 0.8em;
    color: #444;
    font-style: italic;
}
ul, ol { margin: 0.4em 0; padding-left: 1.6em; }
li { margin: 0.2em 0; break-inside: avoid; }
a { color: #1a5276; text-decoration: none; }
"""

_MD_EXTENSIONS = ["tables", "fenced_code", "sane_lists", "toc", "attr_list"]

# A GFM table separator row, e.g. "|---|:--:|---|" or "--- | ---".
# Requires at least one internal pipe so a plain "---" horizontal rule is NOT
# matched. Cells may carry leading/trailing colons for alignment.
_TABLE_SEPARATOR_RE = re.compile(
    r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$"
)


def _fix_table_blank_lines(md_text: str) -> str:
    """
    Python-Markdown's `tables` extension only recognises a table when a BLANK
    LINE precedes the header row. Models frequently emit a label immediately
    above the table with no blank line, e.g.:

        **Air pollutants (within permit limits):**
        | Pollutant | Emission |
        |-----------|----------|
        | NOx       | 42.0     |

    Without the blank line the whole block is parsed as a single paragraph, so
    every pipe renders as a literal `|` and the rows collapse onto one line.

    This inserts the missing blank line before the header row of any table whose
    separator line is preceded by a non-blank, non-table line. Tables that
    already have a preceding blank line are left untouched. Fenced code blocks
    are skipped so ASCII art / diff hunks are never altered.
    """
    lines = md_text.split("\n")
    out: list[str] = []
    in_fence = False
    fence_marker = ""

    for line in lines:
        stripped = line.lstrip()
        # Track fenced code blocks (``` or ~~~) — never touch their contents.
        if not in_fence and (stripped.startswith("```") or stripped.startswith("~~~")):
            in_fence = True
            fence_marker = stripped[:3]
            out.append(line)
            continue
        if in_fence:
            if stripped.startswith(fence_marker):
                in_fence = False
            out.append(line)
            continue

        # A separator row identifies a table. The header is the line just above
        # it (out[-1]); the line above the header (out[-2]) must be blank for the
        # table extension to fire. Insert a blank line when it is missing.
        if _TABLE_SEPARATOR_RE.match(line) and len(out) >= 1 and "|" in out[-1]:
            if len(out) >= 2 and out[-2].strip() != "":
                out.insert(len(out) - 1, "")

        out.append(line)

    return "\n".join(out)


def _markdown_to_html(md_text: str) -> str:
    body = markdown.markdown(
        _fix_table_blank_lines(md_text), extensions=_MD_EXTENSIONS
    )
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
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large: {len(data)} bytes exceeds limit of {_MAX_UPLOAD_BYTES} bytes",
        )
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
        - 413 if the markdown payload exceeds MAX_UPLOAD_BYTES
    """
    if len(req.markdown.encode("utf-8")) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"markdown payload too large: exceeds limit of {_MAX_UPLOAD_BYTES} bytes",
        )

    fmt = req.format.lower()
    if fmt not in ("pdf", "docx"):
        raise HTTPException(status_code=400, detail=f"unknown format '{req.format}'; use 'pdf' or 'docx'")

    html = _markdown_to_html(req.markdown)

    if fmt == "pdf":
        try:
            # Use the SSRF-safe url_fetcher to block external resource fetching.
            pdf_bytes = weasyprint.HTML(string=html).write_pdf(
                url_fetcher=_ssrf_safe_url_fetcher
            )
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
