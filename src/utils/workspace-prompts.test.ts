import { describe, expect, it } from 'vitest'
import { selectWorkspacePromptTexts, selectWorkspacePrompts } from './workspace-prompts'

describe('workspace prompt selection', () => {
  it('selects three prompts from different categories', () => {
    const prompts = selectWorkspacePrompts(() => 0.25)

    expect(prompts).toHaveLength(3)
    expect(new Set(prompts.map((prompt) => prompt.category)).size).toBe(3)
  })

  it('returns localized display text without changing the selected catalog', () => {
    expect(selectWorkspacePromptTexts('zh-CN', () => 0.25)).toHaveLength(3)
    expect(selectWorkspacePromptTexts('en-US', () => 0.25)).toHaveLength(3)
  })
})
