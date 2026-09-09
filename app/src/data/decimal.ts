// Prices and ratios arrive as decimal strings and stay decimal strings. Every
// operation here is done on the digits, so a ratio never passes through a
// binary float and never gains a rounding artefact on the way to the screen.

interface Parts {
  negative: boolean
  int: string
  frac: string
}

function parse(value: string): Parts | null {
  const text = value.trim()
  if (!/^[+-]?\d*(?:\.\d*)?$/.test(text) || !/\d/.test(text)) return null
  const negative = text.startsWith('-')
  const body = text.replace(/^[+-]/, '')
  const [int = '', frac = ''] = body.split('.')
  return { negative, int: int.replace(/^0+(?=\d)/, '') || '0', frac }
}

function join({ negative, int, frac }: Parts): string {
  const digits = frac.replace(/0+$/, '')
  const body = digits ? `${int}.${digits}` : int
  return negative && /[1-9]/.test(int + frac) ? `-${body}` : body
}

/** Moves the decimal point `places` to the right. Exact, no arithmetic. */
export function shift(value: string, places: number): string | null {
  const parts = parse(value)
  if (!parts) return null
  let { int, frac } = parts
  if (places >= 0) {
    const padded = frac.padEnd(places, '0')
    int += padded.slice(0, places)
    frac = padded.slice(places)
  } else {
    const take = -places
    const padded = int.padStart(take, '0')
    frac = padded.slice(padded.length - take) + frac
    int = padded.slice(0, padded.length - take) || '0'
  }
  return join({ ...parts, int: int.replace(/^0+(?=\d)/, '') || '0', frac })
}

/** Half-up rounding to `places` decimals, carried out digit by digit. */
export function round(value: string, places: number): string | null {
  const parts = parse(value)
  if (!parts) return null
  const { negative, int, frac } = parts
  if (frac.length <= places) return join({ negative, int, frac: frac.padEnd(places, '0') })
  const keep = frac.slice(0, places)
  const next = frac.charCodeAt(places) - 48
  let digits = int + keep
  if (next >= 5) {
    const carried = (BigInt(digits) + 1n).toString().padStart(digits.length, '0')
    digits = carried
  }
  const cut = digits.length - places
  return join({
    negative,
    int: digits.slice(0, cut).replace(/^0+(?=\d)/, '') || '0',
    frac: digits.slice(cut),
  })
}

/** Thousands separators for the integer part; the fraction is left alone. */
export function group(value: string): string {
  const parts = parse(value)
  if (!parts) return value
  const int = parts.int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = parts.frac ? `${int}.${parts.frac}` : int
  return parts.negative ? `-${body}` : body
}

export function isNegative(value: string): boolean {
  const parts = parse(value)
  return !!parts && parts.negative && /[1-9]/.test(parts.int + parts.frac)
}

export function isZero(value: string): boolean {
  const parts = parse(value)
  return !!parts && !/[1-9]/.test(parts.int + parts.frac)
}

/**
 * Ratio (0.0182) to a signed percentage (+1.82%). The backend calls these
 * ratios, so the conversion is a two-place shift, never a multiplication.
 */
export function percent(value: string | null | undefined, places = 2): string | null {
  if (value === null || value === undefined) return null
  const shifted = shift(value, 2)
  if (shifted === null) return null
  const rounded = round(shifted, places)
  if (rounded === null) return null
  const sign = isNegative(rounded) || isZero(rounded) ? '' : '+'
  return `${sign}${rounded}%`
}

/** A price as written by the exchange, only grouped for reading. */
export function price(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const parts = parse(value)
  if (!parts) return null
  return group(join(parts))
}
