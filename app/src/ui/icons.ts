// The only trusted markup in the app. These strings are authored here and
// parsed once into <template>; nothing from the API or from a user ever takes
// this path.

const ICONS: Record<string, string> = {
  search:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="9" r="6"/><path d="M14 14l3.5 3.5"/></svg>',
  review:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h12v9H8l-4 3z"/><path d="M7 8h6M7 10.5h4"/></svg>',
  archive:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h14v10H3z"/><path d="M3 6l2-3h10l2 3"/><path d="M8 10h4"/></svg>',
  play:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16V4l6 4-6 4"/><path d="M11 5h5M11 9h5M11 13h5"/></svg>',
  gear:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/></svg>',
  chev:'<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4l2.5 2.5L7.5 4"/></svg>',
  tri:'<svg viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5l4 3.5-4 3.5z"/></svg>',
  check:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>',
  close:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
  info:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.5v.5" stroke-linecap="round"/></svg>',
  img:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 13l4-4 3 3 2-2 5 5"/><circle cx="13" cy="8" r="1.2" fill="currentColor" stroke="none"/></svg>',
  link:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8.5 11.5l3-3M7 13l-1.5 1.5a2.5 2.5 0 01-3.5-3.5L4.5 8.5M13 7l1.5-1.5a2.5 2.5 0 013.5 3.5L15.5 11.5"/></svg>',
  tag:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 3h7l7 7-7 7-7-7z"/><circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none"/></svg>',
  q:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="7.5"/><path d="M7.8 8a2.2 2.2 0 114 1.2c-.9.7-1.8 1.1-1.8 2.3M10 14.5v.3"/></svg>',
  scale:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v14M4 6h12M4 6l-2.5 6a2.5 2.5 0 005 0zM16 6l-2.5 6a2.5 2.5 0 005 0z"/></svg>',
  plus:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>',
  wave:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5c1.6 0 1.9-4 3.5-4s1.9 6 3.5 6 2-8 3.6-8 1.9 5 3.4 5"/><path d="M2 16.5h16" opacity=".45"/></svg>',
  home:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l7-5.5L17 9"/><path d="M5 8.6V16h10V8.6"/><path d="M8.4 16v-3.6h3.2V16"/></svg>',
  zoom:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5"/></svg>',
}

export type IconName = keyof typeof ICONS

const cache = new Map<string, SVGElement>()

export function icon(name: string): SVGElement {
  const source = ICONS[name]
  if (!source) throw new Error(`unknown icon: ${name}`)
  let node = cache.get(name)
  if (!node) {
    const template = document.createElement('template')
    template.innerHTML = source
    node = template.content.firstElementChild as SVGElement
    cache.set(name, node)
  }
  return node.cloneNode(true) as SVGElement
}
