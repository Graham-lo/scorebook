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
pub use scorebook_core::ports::ImageMeta;

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
    pub fn decode(bytes: &[u8]) -> Result<(image::DynamicImage, ImageMeta)> {
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
        let meta = ImageMeta {
            digest: hash_bytes(bytes),
            mime: format.to_mime_type().into(),
            width: im.width(),
            height: im.height(),
        };
        Ok((im, meta))
    }
    pub fn inspect(bytes: &[u8]) -> Result<ImageMeta> {
        Self::decode(bytes).map(|(_, meta)| meta)
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

impl scorebook_core::ports::OriginalImageStore for Storage {
    fn publish(
        &self,
        owner: Uuid,
        id: Uuid,
        bytes: Vec<u8>,
    ) -> scorebook_core::ports::AppFuture<'_, ImageMeta> {
        let storage = self.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || storage.publish(owner, id, &bytes))
                .await
                .map_err(|_| scorebook_core::error::Error::bad("image_processing_failed"))?
                .map_err(Into::into)
        })
    }
    fn open(
        &self,
        owner: Uuid,
        id: Uuid,
    ) -> scorebook_core::ports::AppFuture<'_, scorebook_core::ports::ImageReader> {
        let path = self.path(owner, id);
        Box::pin(async move {
            let file = tokio::fs::File::open(path)
                .await
                .map_err(crate::error::Error::from)?;
            Ok(Box::pin(file) as scorebook_core::ports::ImageReader)
        })
    }
    fn remove(&self, owner: Uuid, id: Uuid) -> scorebook_core::ports::AppFuture<'_, ()> {
        let path = self.path(owner, id);
        Box::pin(async move {
            match tokio::fs::remove_file(path).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(crate::error::Error::from(e).into()),
            }
        })
    }
}
