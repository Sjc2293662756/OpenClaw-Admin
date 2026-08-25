import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import type { ChatMessage } from '@/api/types'

const STREAM_MESSAGE_PREFIX = 'chat-stream:'

function firstCharacter(value: string): string {
  return Array.from(value)[0] || ''
}

function commonPrefix(left: string, right: string): string {
  const leftCharacters = Array.from(left)
  const rightCharacters = Array.from(right)
  const limit = Math.min(leftCharacters.length, rightCharacters.length)
  let index = 0
  while (index < limit && leftCharacters[index] === rightCharacters[index]) {
    index += 1
  }
  return leftCharacters.slice(0, index).join('')
}

function charactersPerFrame(remaining: number): number {
  if (remaining > 360) return 12
  if (remaining > 180) return 8
  if (remaining > 80) return 4
  if (remaining > 32) return 2
  return 1
}

function findLiveStreamMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message?.role === 'assistant' &&
      message.id?.startsWith(STREAM_MESSAGE_PREFIX)
    ) {
      return message
    }
  }
  return null
}

/**
 * Smooths only the temporary, canonical `chat` projection used while a reply is
 * streaming. The source transcript remains untouched and persisted history is
 * never replayed with a typing animation.
 */
export function useProgressiveChatPresentation(
  sessionKey: Readonly<Ref<string | null | undefined>>,
  messages: Readonly<Ref<ChatMessage[]>>,
) {
  const activeStreamId = ref('')
  const activeSessionKey = ref(sessionKey.value || '')
  const displayedContent = ref('')
  const targetContent = ref('')
  const streamPresent = ref(false)
  const replacementMessage = shallowRef<ChatMessage | null>(null)
  let animationFrame: number | null = null

  function cancelAnimation() {
    if (animationFrame === null) return
    cancelAnimationFrame(animationFrame)
    animationFrame = null
  }

  function clearPresentation() {
    cancelAnimation()
    activeStreamId.value = ''
    displayedContent.value = ''
    targetContent.value = ''
    streamPresent.value = false
    replacementMessage.value = null
  }

  function finishIfPersisted() {
    if (streamPresent.value || displayedContent.value !== targetContent.value) return
    clearPresentation()
  }

  function scheduleAnimation() {
    if (animationFrame !== null || !activeStreamId.value) return
    if (displayedContent.value === targetContent.value) {
      finishIfPersisted()
      return
    }

    animationFrame = requestAnimationFrame(() => {
      animationFrame = null
      const displayed = displayedContent.value
      const target = targetContent.value
      if (!target.startsWith(displayed)) {
        displayedContent.value = commonPrefix(displayed, target)
      }

      const suffix = targetContent.value.slice(displayedContent.value.length)
      const remainingCharacters = Array.from(suffix)
      const count = charactersPerFrame(remainingCharacters.length)
      displayedContent.value += remainingCharacters.slice(0, count).join('')

      if (displayedContent.value !== targetContent.value) {
        scheduleAnimation()
      } else {
        finishIfPersisted()
      }
    })
  }

  function updateTarget(content: string) {
    if (targetContent.value === content) return
    if (!content.startsWith(displayedContent.value)) {
      displayedContent.value = commonPrefix(displayedContent.value, content)
    }
    targetContent.value = content
    scheduleAnimation()
  }

  function findPersistedReplacement(list: ChatMessage[]): ChatMessage | null {
    const displayed = displayedContent.value
    const target = targetContent.value
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message?.role !== 'assistant' || !message.content) continue
      if (
        message.content === target ||
        message.content.startsWith(target) ||
        (displayed.length >= 4 && message.content.startsWith(displayed))
      ) {
        return message
      }
    }
    return null
  }

  watch(
    [() => sessionKey.value || '', () => messages.value],
    ([nextSessionKey, list]) => {
      if (nextSessionKey !== activeSessionKey.value) {
        clearPresentation()
        activeSessionKey.value = nextSessionKey
        return
      }

      const streamMessage = findLiveStreamMessage(list)
      if (streamMessage) {
        const streamId = streamMessage.id || ''
        if (streamId !== activeStreamId.value) {
          clearPresentation()
          activeStreamId.value = streamId
          displayedContent.value = firstCharacter(streamMessage.content)
          targetContent.value = streamMessage.content
        } else {
          updateTarget(streamMessage.content)
        }
        streamPresent.value = true
        replacementMessage.value = null
        scheduleAnimation()
        return
      }

      if (!activeStreamId.value) return
      streamPresent.value = false
      const replacement = findPersistedReplacement(list)
      if (!replacement) {
        clearPresentation()
        return
      }
      replacementMessage.value = replacement
      updateTarget(replacement.content)
      scheduleAnimation()
    },
    { flush: 'sync', immediate: true },
  )

  const presentedMessages = computed<ChatMessage[]>(() => {
    if (!activeStreamId.value) return messages.value

    let targetMessage: ChatMessage | null = null
    const list = messages.value
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message?.id === activeStreamId.value) {
        targetMessage = message
        break
      }
    }
    if (!targetMessage && replacementMessage.value && list.includes(replacementMessage.value)) {
      targetMessage = replacementMessage.value
    }
    if (!targetMessage || targetMessage.content === displayedContent.value) return list

    return list.map((message) => {
      if (message !== targetMessage) return message
      return {
        ...message,
        content: displayedContent.value,
        // A persisted replacement can carry its final structured payload. It
        // must not bypass the partial presentation text during convergence.
        rawContent: undefined,
      }
    })
  })

  onScopeDispose(clearPresentation)

  return {
    presentedMessages,
  }
}
