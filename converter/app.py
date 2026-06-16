import io
import os
from fastapi import FastAPI, File, HTTPException, UploadFile
from markitdown import MarkItDown

app = FastAPI(title="reporting-agent converter")
md = MarkItDown(enable_plugins=False)

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
