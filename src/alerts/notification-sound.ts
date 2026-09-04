type AudioContextLike = {
  state: string
  currentTime: number
  destination: AudioNode
  resume: () => Promise<void>
  createOscillator: () => OscillatorNode
  createGain: () => GainNode
}

export const ALERT_SOUND_IDS = [
  'minor-soft',
  'major-chime',
  'critical-pulse',
  'rising-bell',
  'falling-bell',
  'digital-ping',
  'woodblock',
  'rapid-signal',
  'none',
] as const
export type AlertSoundId = typeof ALERT_SOUND_IDS[number]

export const DEFAULT_ALERT_SOUNDS = Object.freeze({
  minorSound: 'minor-soft',
  majorSound: 'major-chime',
  criticalSound: 'critical-pulse',
} satisfies Record<'minorSound' | 'majorSound' | 'criticalSound', AlertSoundId>)

type AlertSoundNote = { frequency: number; offset: number; duration: number; gain: number; wave: OscillatorType }

const ALERT_SOUND_PATTERNS: Record<Exclude<AlertSoundId, 'none'>, AlertSoundNote[]> = {
  // These deliberately use short, restrained interface-style tones. They avoid
  // musical sweeps and alarm-siren effects, which are distracting in an office.
  'minor-soft': [{ frequency: 576, offset: 0, duration: .13, gain: .045, wave: 'sine' }],
  'major-chime': [
    { frequency: 576, offset: 0, duration: .09, gain: .065, wave: 'sine' },
    { frequency: 720, offset: .15, duration: .12, gain: .075, wave: 'sine' },
  ],
  'critical-pulse': [
    { frequency: 620, offset: 0, duration: .12, gain: .09, wave: 'triangle' },
    { frequency: 620, offset: .19, duration: .12, gain: .09, wave: 'triangle' },
    { frequency: 620, offset: .38, duration: .12, gain: .09, wave: 'triangle' },
  ],
  'rising-bell': [
    { frequency: 892, offset: 0, duration: .07, gain: .065, wave: 'triangle' },
    { frequency: 892, offset: .13, duration: .07, gain: .065, wave: 'triangle' },
  ],
  'falling-bell': [
    { frequency: 432, offset: 0, duration: .15, gain: .075, wave: 'sine' },
    { frequency: 432, offset: .21, duration: .09, gain: .055, wave: 'sine' },
  ],
  'digital-ping': [
    { frequency: 1047, offset: 0, duration: .045, gain: .055, wave: 'square' },
    { frequency: 784, offset: .09, duration: .045, gain: .05, wave: 'square' },
  ],
  woodblock: [
    { frequency: 660, offset: 0, duration: .055, gain: .075, wave: 'sine' },
    { frequency: 660, offset: .14, duration: .055, gain: .075, wave: 'sine' },
  ],
  'rapid-signal': [
    { frequency: 660, offset: 0, duration: .07, gain: .065, wave: 'triangle' },
    { frequency: 660, offset: .12, duration: .07, gain: .065, wave: 'triangle' },
    { frequency: 660, offset: .24, duration: .07, gain: .065, wave: 'triangle' },
    { frequency: 660, offset: .36, duration: .07, gain: .065, wave: 'triangle' },
  ],
}

let audioContext: AudioContextLike | null = null

export function isAlertSoundId(value: unknown): value is AlertSoundId {
  return typeof value === 'string' && (ALERT_SOUND_IDS as readonly string[]).includes(value)
}

function getAudioContext() {
  if (audioContext || typeof window === 'undefined') return audioContext
  const AudioContextConstructor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) return null
  audioContext = new AudioContextConstructor()
  return audioContext
}

export function playAlertNotificationSound(soundId: AlertSoundId) {
  if (soundId === 'none') return false
  const context = getAudioContext()
  if (!context || context.state !== 'running') return false
  try {
    const startedAt = context.currentTime
    ALERT_SOUND_PATTERNS[soundId].forEach((note) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const noteStart = startedAt + note.offset
      const noteEnd = noteStart + note.duration
      oscillator.type = note.wave
      oscillator.frequency.setValueAtTime(note.frequency, noteStart)
      gain.gain.setValueAtTime(.0001, noteStart)
      gain.gain.exponentialRampToValueAtTime(note.gain, noteStart + .018)
      gain.gain.exponentialRampToValueAtTime(.0001, noteEnd)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(noteStart)
      oscillator.stop(noteEnd + .02)
    })
    return true
  } catch {
    return false
  }
}

// The first normal page interaction unlocks Web Audio in browsers that require
// a user gesture. Audio remains optional if the browser or device has no support.
export function primeAlertNotificationSound() {
  const context = getAudioContext()
  return context?.state === 'suspended' ? context.resume().catch(() => {}) : Promise.resolve()
}
