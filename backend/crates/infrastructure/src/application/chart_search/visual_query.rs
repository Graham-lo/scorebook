//! Explicit reverse mode changes both geometry and visual retrieval, never stored originals.
use super::*;
use image::GenericImageView;
use tokio::io::AsyncReadExt;
pub async fn encode(
    s: &Services,
    owner: Uuid,
    input: &ChartSearchInput,
    region: &scorebook_core::api::dto::Region,
) -> Result<pgvector::Vector> {
    if !input.reverse {
        return Ok(super::super::similarity::embed_mode(
            s,
            owner,
            input.attachment_id,
            input.region.clone(),
            "dinov2-small-v1",
            false,
        )
        .await?
        .0);
    }
    let expected: String =
        sqlx::query_scalar("SELECT sha256 FROM attachments WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(input.attachment_id)
            .fetch_optional(&s.db.pool)
            .await?
            .ok_or_else(Error::not_found)?;
    let mut bytes = Vec::new();
    s.images
        .open(owner, input.attachment_id)
        .await?
        .take(20 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 20 * 1024 * 1024 || crate::adapters::db::hash_bytes(&bytes) != expected {
        return Err(Error::bad("attachment_integrity_failure"));
    }
    let r = region.clone();
    let im = tokio::task::spawn_blocking(move || -> Result<image::DynamicImage> {
        let (im, _) = crate::adapters::storage::Storage::decode(&bytes)?;
        let (w, h) = im.dimensions();
        if r.x.checked_add(r.width).is_none_or(|x| x > w)
            || r.y.checked_add(r.height).is_none_or(|y| y > h)
        {
            return Err(Error::bad("invalid_region"));
        }
        let mut rgb = im.crop_imm(r.x, r.y, r.width, r.height).flipv().to_rgb8();
        for pixel in rgb.pixels_mut() {
            let [red, green, blue] = pixel.0;
            let (red, green, blue) = (red as f64, green as f64, blue as f64);
            if (red > green * 1.25 && red > blue * 1.1 && red > 65.)
                || (green > red * 1.15 && green > blue * 1.02 && green > 65.)
            {
                pixel.0.swap(0, 1);
            }
        }
        Ok(image::DynamicImage::ImageRgb8(rgb))
    })
    .await
    .map_err(|_| Error::bad("image_processing_interrupted"))??;
    let f = s
        .vision
        .extract_batch(vec![im], "dinov2-small-v1")
        .await?
        .pop()
        .ok_or_else(|| Error::bad("invalid_visual_response"))?;
    Ok(pgvector::Vector::from(f.vector))
}
