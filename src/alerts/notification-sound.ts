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

// A standard two-pulse warning is shared by every severity. It is deliberately
// non-melodic, so it reads as an alert rather than an ordinary chat message.
export function playAlertNotificationSound() {
  const context = getAudioContext()
  if (!context || context.state !== 'running') return false
  try {
    const startedAt = context.currentTime
    ;[
      { offset: 0 },
      { offset: .16 },
    ].forEach((note) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const noteStart = startedAt + note.offset
      const noteEnd = noteStart + .1
      oscillator.type = 'square'
      oscillator.frequency.setValueAtTime(880, noteStart)
      gain.gain.setValueAtTime(.0001, noteStart)
      gain.gain.exponentialRampToValueAtTime(.12, noteStart + .012)
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
  if (context?.state === 'suspended') void context.resume().catch(() => {})
}
