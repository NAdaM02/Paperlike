//! Rasterise one page of an embedded PDF with the Windows PDF API.
//! The bytes stay in the note; this only produces a bitmap for the exported PDF.

use anyhow::{Context, Result};
use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
use windows::Storage::Streams::{DataReader, DataWriter, InMemoryRandomAccessStream};

/// Bitmap of a 1-based page, `dest_w` pixels wide. Windows writes a PNG.
pub fn render_pdf_page(bytes: &[u8], page_1based: u32, dest_w: u32) -> Result<Vec<u8>> {
    let dest_w = dest_w.max(1);
    let input = InMemoryRandomAccessStream::new().context("pdf input stream")?;
    let writer = DataWriter::CreateDataWriter(&input).context("pdf writer")?;
    writer.WriteBytes(bytes).context("write pdf bytes")?;
    writer.StoreAsync().context("store pdf")?.join().context("store pdf")?;
    writer.FlushAsync().context("flush pdf")?.join().context("flush pdf")?;
    writer.DetachStream().context("detach pdf stream")?;
    input.Seek(0).context("rewind pdf")?;

    let doc = PdfDocument::LoadFromStreamAsync(&input)
        .context("load pdf")?
        .join()
        .context("load pdf")?;
    let count = doc.PageCount().context("page count")?;
    let index = page_1based.saturating_sub(1);
    if index >= count {
        anyhow::bail!("pdf has no page {page_1based}");
    }
    let page = doc.GetPage(index).context("get page")?;
    let size = page.Size().context("page size")?;
    let dest_h = ((dest_w as f32) * size.Height / size.Width.max(1.0))
        .round()
        .max(1.0) as u32;

    let opts = PdfPageRenderOptions::new().context("render options")?;
    opts.SetDestinationWidth(dest_w).context("dest width")?;
    opts.SetDestinationHeight(dest_h).context("dest height")?;

    let output = InMemoryRandomAccessStream::new().context("pdf output stream")?;
    page.RenderWithOptionsToStreamAsync(&output, &opts)
        .context("render page")?
        .join()
        .context("render page")?;
    output.Seek(0).context("rewind render")?;
    let len = output.Size().context("render size")? as u32;
    if len == 0 {
        anyhow::bail!("pdf page rendered empty");
    }
    let reader = DataReader::CreateDataReader(&output).context("read render")?;
    reader.LoadAsync(len).context("load render")?.join().context("load render")?;
    let mut buf = vec![0u8; len as usize];
    reader.ReadBytes(&mut buf).context("copy render")?;
    Ok(buf)
}
