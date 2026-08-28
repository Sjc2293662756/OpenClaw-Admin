type AudioContextLike = {
  state: string
  currentTime: number
  destination: AudioNode
  resume: () => Promise<void>
  createOscillator: () => OscillatorNode
  createGain: () => GainNode
}

let audioContext: AudioContextLike | null = null

function getAudioContext() {
  if (audioContext || typeof window === 'undefined') return audioContext
  const AudioContextConstructor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) return null
  audioContext = new AudioContextConstructor()
  return audioContext
}

// A single, clear chime is intentionally shared by every severity: it remains
// recognisable as an alert without creating a second severity taxonomy in sound.
export function playAlertNotificationSound() {
  const context = getAudioContext()
  if (!context || context.state !== 'running') return false
  try {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const startedAt = context.currentTime
    const endedAt = startedAt + .28
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, startedAt)
    gain.gain.setValueAtTime(.0001, startedAt)
    gain.gain.exponentialRampToValueAtTime(.22, startedAt + .022)
    gain.gain.exponentialRampToValueAtTime(.0001, endedAt)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(startedAt)
    oscillator.stop(endedAt + .02)
    return true
  } catch {
    return false
  }
}

// The first normal page interaction unlocks Web Audio in browsers that require
// a user gesture. Audio remains optional if the browser or device has no support.
export function primeAlertNotificationSound() {
  const context = getAudioContext()
  if (context?.state === 'suspended') void context.resume().catch(() => {})
}
