use crate::{
    adapters::db::hash_bytes,
    error::{Error, Result},
};
use image::ImageReader;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{File, OpenOptions},
    io::{Cursor, Write},
    path::PathBuf,
};
use uuid::Uuid;
#[derive(Clone)]
pub struct Storage {
    pub root: PathBuf,
}
pub struct ImageMeta {
    pub digest: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}
impl Storage {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn path(&self, owner: Uuid, id: Uuid) -> PathBuf {
        self.root
            .join("attachments")
            .join(owner.to_string())
            .join(id.to_string())
    }
    pub fn inspect(bytes: &[u8]) -> Result<ImageMeta> {
        if bytes.len() > 20 * 1024 * 1024 {
            return Err(Error::bad("image_too_large"));
        }
        let mut r = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|_| Error::bad("invalid_image"))?;
        let format = r.format().ok_or_else(|| Error::bad("unsupported_image"))?;
        if !matches!(
            format,
            image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
        ) {
            return Err(Error::bad("unsupported_image"));
        }
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(128 * 1024 * 1024);
        r.limits(limits);
        let im = r
            .decode()
            .map_err(|_| Error::bad("invalid_or_oversize_image"))?;
        Ok(ImageMeta {
            digest: hash_bytes(bytes),
            mime: format.to_mime_type().into(),
            width: im.width(),
            height: im.height(),
        })
    }
    pub fn publish(&self, owner: Uuid, id: Uuid, bytes: &[u8]) -> Result<ImageMeta> {
        let meta = Self::inspect(bytes)?;
        let path = self.path(owner, id);
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        let temp = parent.join(format!(".{}.tmp", Uuid::new_v4()));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(temp, &path)?;
        File::open(parent)?.sync_all()?;
        if let Some(p) = parent.parent() {
            File::open(p)?.sync_all()?;
        }
        File::open(&self.root)?.sync_all()?;
        Ok(meta)
    }
}
