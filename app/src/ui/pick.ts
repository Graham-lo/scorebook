// One way in for every image: drag, paste, or the file dialog. The picked
// File is kept as-is — the original bytes are what gets uploaded, so a crop
// is expressed as coordinates rather than by re-encoding the picture.

const IMAGE = /^image\/(png|jpeg|webp)$/

export interface PickOptions {
  onPick: (file: File) => void
  onReject?: (why: string) => void
  /** Where drag feedback is shown; defaults to the same element. */
  highlight?: HTMLElement
}

function firstImage(list: FileList | null | undefined, items?: DataTransferItemList): File | null {
  for (const file of Array.from(list ?? [])) if (IMAGE.test(file.type)) return file
  for (const item of Array.from(items ?? [])) {
    if (item.kind === 'file' && IMAGE.test(item.type)) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

/** Drag-and-drop plus click-to-browse on one element. Returns a detach fn. */
export function dropzone(node: HTMLElement, options: PickOptions): () => void {
  const target = options.highlight ?? node
  let depth = 0
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp'
  input.hidden = true
  node.appendChild(input)

  const enter = (e: DragEvent) => {
    e.preventDefault()
    depth += 1
    target.classList.add('dragging')
  }
  const leave = (e: DragEvent) => {
    e.preventDefault()
    depth -= 1
    if (depth <= 0) target.classList.remove('dragging')
  }
  const over = (e: DragEvent) => e.preventDefault()
  const drop = (e: DragEvent) => {
    e.preventDefault()
    depth = 0
    target.classList.remove('dragging')
    const file = firstImage(e.dataTransfer?.files, e.dataTransfer?.items)
    if (file) options.onPick(file)
    else options.onReject?.('只能放 PNG、JPEG 或 WebP 图片。')
  }
  const browse = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,a,input,textarea')) return
    input.click()
  }
  const chosen = () => {
    const file = firstImage(input.files)
    if (file) options.onPick(file)
    else if (input.files?.length) options.onReject?.('只能选 PNG、JPEG 或 WebP 图片。')
    input.value = ''
  }

  node.addEventListener('dragenter', enter)
  node.addEventListener('dragleave', leave)
  node.addEventListener('dragover', over)
  node.addEventListener('drop', drop)
  node.addEventListener('click', browse)
  input.addEventListener('change', chosen)

  return () => {
    node.removeEventListener('dragenter', enter)
    node.removeEventListener('dragleave', leave)
    node.removeEventListener('dragover', over)
    node.removeEventListener('drop', drop)
    node.removeEventListener('click', browse)
    input.remove()
  }
}

/** Paste anywhere on the page while a capture surface is open. */
export function onPaste(options: PickOptions): () => void {
  const handler = (e: ClipboardEvent) => {
    const file = firstImage(e.clipboardData?.files, e.clipboardData?.items)
    if (!file) return
    e.preventDefault()
    options.onPick(file)
  }
  document.addEventListener('paste', handler)
  return () => document.removeEventListener('paste', handler)
}

export function openFileDialog(options: PickOptions): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp'
  input.addEventListener('change', () => {
    const file = firstImage(input.files)
    if (file) options.onPick(file)
    else options.onReject?.('只能选 PNG、JPEG 或 WebP 图片。')
  })
  input.click()
}
