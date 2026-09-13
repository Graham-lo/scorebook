// 天上那几样装饰：太阳、地平线、时间标尺、晨光走势线。
//
// 全部住在 .sky 里，那一层本来就是 aria-hidden 且不吃鼠标，所以它们只是看的，
// 拦不住任何操作。窄屏不画，系统减弱动效或设置里关掉动效时也不画（样式里管）。
// 走势线每次换页重画一遍，那条金线会跟着页面重新长出来。

const PATH = 'M0 300 C 240 290 380 250 520 236 S 780 260 900 214 S 1120 120 1260 128 S 1500 60 1620 52 S 1800 30 1920 24'
const HOURS = ['06', '09', '12', '15', '18', '21', '24']
const SVG = 'http://www.w3.org/2000/svg'

/** 现在这个钟点落在标尺的哪一格上。 */
export function tickFor(hour: number): string {
  if (hour >= 5 && hour <= 7) return '06'
  if (hour >= 8 && hour <= 10) return '09'
  if (hour >= 11 && hour <= 13) return '12'
  if (hour >= 14 && hour <= 16) return '15'
  if (hour >= 17 && hour <= 19) return '18'
  if (hour >= 20 && hour <= 22) return '21'
  return '24'
}

/** 每次换页调一次：走势线重画，标尺上的当前刻度重新对时。 */
export function paintDecor(now = new Date()): void {
  const sky = document.querySelector('.sky')
  if (!sky) return
  if (!sky.querySelector('.sun-disc')) sky.appendChild(el('i', 'sun-disc'))
  if (!sky.querySelector('.horizon')) sky.appendChild(el('i', 'horizon'))
  sky.querySelector('.dawnline')?.remove()
  sky.appendChild(dawnline())
  let rail = sky.querySelector('.tick-rail')
  if (!rail) {
    rail = el('div', 'tick-rail')
    for (const hour of HOURS) {
      const tick = el('span', '')
      tick.textContent = hour
      rail.appendChild(tick)
    }
    sky.appendChild(rail)
  }
  const here = tickFor(now.getHours())
  for (const tick of Array.from(rail.children)) tick.classList.toggle('now', tick.textContent === here)
}

/** 本机钟点对应的那一句问候。 */
export function greeting(hour: number): string {
  if (hour >= 5 && hour <= 8) return '清晨好'
  if (hour >= 9 && hour <= 11) return '上午好'
  if (hour >= 12 && hour <= 13) return '午间好'
  if (hour >= 14 && hour <= 17) return '午后好'
  if (hour >= 18 && hour <= 21) return '傍晚好'
  return '夜深了'
}

/** 06:00–18:00 这一段里现在走到哪儿了，0 到 1。 */
export function daylight(now: Date): number {
  const minutes = now.getHours() * 60 + now.getMinutes()
  return Math.max(0, Math.min(1, (minutes - 360) / 720))
}

function clock(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/**
 * 日晷。纯装饰：一条虚线弧、走过的那一段实线、停在弧上的太阳和当前时刻。
 * 返回的 `tick` 每分钟叫一次就够了。
 */
export function sundial(): { node: HTMLElement; tick: (now?: Date) => void } {
  const node = el('div', 'sundial')
  node.setAttribute('aria-hidden', 'true')
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 260 150')
  const arc = ns('path', { class: 'arc', d: ARC })
  const lit = ns('path', { class: 'lit', d: ARC })
  const ground = ns('line', { class: 'ground', x1: '0', y1: '130', x2: '260', y2: '130' })
  const ticks = ns('g', { class: 'tk' })
  ticks.append(
    ns('line', { x1: '10', y1: '126', x2: '10', y2: '134' }),
    ns('line', { x1: '130', y1: '6', x2: '130', y2: '14' }),
    ns('line', { x1: '250', y1: '126', x2: '250', y2: '134' }),
  )
  const sun = ns('circle', { class: 'sun', cx: '130', cy: '10', r: '9' })
  const left = ns('text', { class: 't', x: '4', y: '148' })
  left.textContent = '06:00'
  const right = ns('text', { class: 't', x: '222', y: '148' })
  right.textContent = '18:00'
  const hh = ns('text', { class: 'hh', x: '130', y: '118', 'text-anchor': 'middle' })
  svg.append(arc, lit, ground, ticks, sun, left, right, hh)
  node.appendChild(svg)

  function tick(now = new Date()): void {
    const k = daylight(now)
    node.style.setProperty('--k', String(k))
    sun.setAttribute('cx', (130 - 120 * Math.cos(Math.PI * k)).toFixed(2))
    sun.setAttribute('cy', (130 - 120 * Math.sin(Math.PI * k)).toFixed(2))
    hh.textContent = clock(now)
  }

  tick()
  return { node, tick }
}

const ARC = 'M10 130 A120 120 0 0 1 250 130'

function ns(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  return node
}

function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  return node
}

function dawnline(): HTMLElement {
  const box = el('div', 'dawnline')
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 1920 360')
  svg.setAttribute('preserveAspectRatio', 'none')
  const area = document.createElementNS(SVG, 'path')
  area.setAttribute('class', 'area')
  area.setAttribute('d', `${PATH} V360 H0Z`)
  const stroke = document.createElementNS(SVG, 'path')
  stroke.setAttribute('d', PATH)
  const dot = document.createElementNS(SVG, 'circle')
  dot.setAttribute('cx', '1620')
  dot.setAttribute('cy', '52')
  dot.setAttribute('r', '4')
  svg.append(area, stroke, dot)
  box.appendChild(svg)
  return box
}
