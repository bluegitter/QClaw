import { computed, ref } from 'vue'
import {
  ALWAYS_ENABLED_SKILL_IDS,
  DEFAULT_SKILL_SETTINGS_OPTIONS,
  SKILL_EMOJI_MAP,
  type MessageLevel,
  type SkillCardSource,
  type SkillSettingsOption,
} from './system-settings'

export function useSkillSettingsPanel() {
  const skillCatalogItems = ref<SkillSettingsOption[]>([...DEFAULT_SKILL_SETTINGS_OPTIONS])
  const bundledSkillsDir = ref('')
  const skillEnabledIdsDraft = ref<string[]>([])
  const skillEnabledIdsSaved = ref<string[]>([])
  const externalSkillDirsDraft = ref<string[]>([])
  const externalSkillDirsSaved = ref<string[]>([])
  const externalSkillItems = ref<SkillSettingsOption[]>([])
  const skillSearchKeyword = ref('')
  const showSkillAddMenu = ref(false)
  const skillSelectedMoreId = ref<string | null>(null)
  const skillMoreMenuPosition = ref({ top: '0px', left: '0px' })
  const selectedSkillId = ref<string | null>(null)
  const showSkillDetail = ref(false)
  const showGithubImportModal = ref(false)
  const githubSkillUrl = ref('')
  const isImportingSkillFromGithub = ref(false)
  const showRemoveSkillConfirm = ref(false)
  const skillPendingRemoval = ref<SkillSettingsOption | null>(null)
  const showDisableSkillConfirm = ref(false)
  const skillPendingDisable = ref<SkillSettingsOption | null>(null)
  const skillSettingsMessage = ref('')
  const skillSettingsMessageLevel = ref<MessageLevel>('warning')
  const skillMoreButtonMap = new Map<string, HTMLElement>()

  function normalizePath(value: string) {
    return value.replace(/\\/g, '/').replace(/\/+$/g, '')
  }

  function isBundledSkillPath(dirPath: string) {
    if (!bundledSkillsDir.value) {
      return false
    }

    const normalizedDir = normalizePath(dirPath)
    const normalizedBundledDir = normalizePath(bundledSkillsDir.value)
    return normalizedDir === normalizedBundledDir || normalizedDir.startsWith(`${normalizedBundledDir}/`)
  }

  function normalizeExternalSkillDirs(dirs?: string[]) {
    if (!Array.isArray(dirs)) {
      return []
    }

    const seen = new Set<string>()
    const nextDirs: string[] = []
    for (const dir of dirs) {
      if (typeof dir !== 'string') {
        continue
      }

      const normalizedDir = normalizePath(dir.trim())
      if (!normalizedDir || isBundledSkillPath(normalizedDir) || seen.has(normalizedDir)) {
        continue
      }

      seen.add(normalizedDir)
      nextDirs.push(normalizedDir)
    }

    return nextDirs
  }

  function normalizeSkillEnabledIds(ids?: string[]) {
    const availableIds = new Set(skillCatalogItems.value.map((item) => item.id))
    const nextIds = Array.isArray(ids)
      ? ids.filter((id, index) => availableIds.has(id) && ids.indexOf(id) === index)
      : skillCatalogItems.value.map((item) => item.id)

    for (const skillId of ALWAYS_ENABLED_SKILL_IDS) {
      if (!nextIds.includes(skillId)) {
        nextIds.push(skillId)
      }
    }

    return nextIds
  }

  function isSkillEnabled(skillId: string) {
    return skillEnabledIdsDraft.value.includes(skillId)
  }

  function getSkillEmoji(item: Partial<SkillSettingsOption>) {
    return item.emoji || SKILL_EMOJI_MAP[item.id || ''] || '🧩'
  }

  function toSkillOption(item: Partial<SkillSettingsOption> & { id: string; name: string; description: string }) {
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      emoji: getSkillEmoji(item),
      path: item.path,
      isBundled: item.isBundled,
      alwaysEnabled: item.alwaysEnabled,
      source: item.source,
      version: item.version,
      ownerId: item.ownerId,
      fullDescription: item.fullDescription,
    } satisfies SkillSettingsOption
  }

  function getSkillSourceLabel(source?: SkillCardSource) {
    if (source === 'builtin') {
      return '内置技能'
    }
    if (source === 'user') {
      return '用户安装'
    }
    return '项目技能'
  }

  const allSkillItems = computed(() => {
    const sourceWeight: Record<SkillCardSource, number> = {
      builtin: 0,
      user: 1,
      project: 2,
    }

    return [...skillCatalogItems.value, ...externalSkillItems.value].sort((left, right) => {
      const leftSource = (left.source || 'project') as SkillCardSource
      const rightSource = (right.source || 'project') as SkillCardSource
      const sourceDiff = sourceWeight[leftSource] - sourceWeight[rightSource]
      if (sourceDiff !== 0) {
        return sourceDiff
      }
      return left.name.localeCompare(right.name, 'zh-CN')
    })
  })

  const filteredSkillItems = computed(() => {
    const keyword = skillSearchKeyword.value.trim().toLowerCase()
    if (!keyword) {
      return allSkillItems.value
    }

    return allSkillItems.value.filter((item) => {
      return (
        item.name.toLowerCase().includes(keyword) ||
        item.description.toLowerCase().includes(keyword) ||
        getSkillSourceLabel(item.source).toLowerCase().includes(keyword)
      )
    })
  })

  const selectedSkillItem = computed(() => {
    return allSkillItems.value.find((item) => item.id === selectedSkillId.value) || null
  })

  function getSkillById(skillId: string | null) {
    if (!skillId) {
      return null
    }
    return allSkillItems.value.find((item) => item.id === skillId) || null
  }

  function closeSkillTransientUi() {
    showSkillAddMenu.value = false
    skillSelectedMoreId.value = null
  }

  function updateSkillSearchKeyword(keyword: string) {
    skillSearchKeyword.value = keyword.trim()
  }

  function clearSkillSearch() {
    skillSearchKeyword.value = ''
  }

  function updateGithubSkillUrl(url: string) {
    githubSkillUrl.value = url.trim()
  }

  function registerSkillMoreButton(skillId: string, element: Element | null) {
    if (!(element instanceof HTMLElement)) {
      skillMoreButtonMap.delete(skillId)
      return
    }
    skillMoreButtonMap.set(skillId, element)
  }

  function openSkillDetail(skill: SkillSettingsOption) {
    selectedSkillId.value = skill.id
    showSkillDetail.value = true
    skillSelectedMoreId.value = null
  }

  function closeSkillDetail() {
    showSkillDetail.value = false
    selectedSkillId.value = null
  }

  function isSkillRemovable(skill: SkillSettingsOption) {
    return !skill.isBundled && !!skill.path
  }

  function toggleSkillAddDropdown() {
    showSkillAddMenu.value = !showSkillAddMenu.value
    if (showSkillAddMenu.value) {
      skillSelectedMoreId.value = null
    }
  }

  function toggleSkillMoreMenu(skill: SkillSettingsOption) {
    if (skillSelectedMoreId.value === skill.id) {
      skillSelectedMoreId.value = null
      return
    }

    const target = skillMoreButtonMap.get(skill.id)
    if (!target) {
      return
    }

    const rect = target.getBoundingClientRect()
    skillMoreMenuPosition.value = {
      top: `${rect.bottom + 8}px`,
      left: `${Math.max(16, rect.right - 88)}px`,
    }
    skillSelectedMoreId.value = skill.id
    showSkillAddMenu.value = false
  }

  function openGithubImportModal() {
    showSkillAddMenu.value = false
    githubSkillUrl.value = ''
    showGithubImportModal.value = true
  }

  function closeGithubImportModal() {
    showGithubImportModal.value = false
    githubSkillUrl.value = ''
  }

  async function persistSkillSettings(
    enabledIds = skillEnabledIdsDraft.value,
    extraDirs = externalSkillDirsDraft.value,
  ) {
    const normalizedIds = normalizeSkillEnabledIds(enabledIds)
    const normalizedExternalDirs = normalizeExternalSkillDirs(extraDirs)
    const skillStateResult = await window.electronAPI?.app.setSelectedSkillIds(normalizedIds)
    if (skillStateResult?.success === false) {
      throw new Error('技能启用状态保存失败')
    }
    const result = await window.electronAPI?.config.updateField({
      skills: {
        load: {
          extraDirs: normalizedExternalDirs,
        },
      },
    })

    if (result?.success === false) {
      throw new Error(result.message || '技能设置保存失败')
    }

    skillEnabledIdsSaved.value = [...normalizedIds]
    skillEnabledIdsDraft.value = [...normalizedIds]
    externalSkillDirsSaved.value = [...normalizedExternalDirs]
    externalSkillDirsDraft.value = [...normalizedExternalDirs]
    return result
  }

  async function loadSkillSettings() {
    try {
      const [catalog, enabledIds, extraDirs] = await Promise.all([
        window.electronAPI?.app.getSkillCatalog(),
        window.electronAPI?.app.getSelectedSkillIds(),
        window.electronAPI?.config.getField('skills.load.extraDirs'),
      ])

      if (Array.isArray(catalog) && catalog.length > 0) {
        skillCatalogItems.value = catalog.map((item) => toSkillOption(item))
        bundledSkillsDir.value = normalizePath(catalog[0]!.path).replace(/\/[^/]+$/, '')
      } else {
        skillCatalogItems.value = [...DEFAULT_SKILL_SETTINGS_OPTIONS]
        bundledSkillsDir.value = ''
      }

      const normalizedIds = normalizeSkillEnabledIds(enabledIds)
      const normalizedExternalDirs = normalizeExternalSkillDirs(extraDirs as string[] | undefined)
      const inspectedExternalSkills = typeof window.electronAPI?.app.listSkillsFromRoots === 'function'
        ? await window.electronAPI.app.listSkillsFromRoots(normalizedExternalDirs)
        : await Promise.all(
          normalizedExternalDirs.map(async (dirPath) => {
            const result = await window.electronAPI?.app.inspectSkillDirectory(dirPath)
            if (!result?.isValid) {
              return null
            }

            return toSkillOption(result)
          }),
        )

      skillEnabledIdsSaved.value = [...normalizedIds]
      skillEnabledIdsDraft.value = [...normalizedIds]
      externalSkillDirsSaved.value = [...normalizedExternalDirs]
      externalSkillDirsDraft.value = [...normalizedExternalDirs]
      externalSkillItems.value = inspectedExternalSkills
        .filter((item): item is SkillSettingsOption => Boolean(item))
        .map((item) => toSkillOption(item))
    } catch (error) {
      console.error('[Chat] 读取技能设置失败:', error)
      const normalizedIds = normalizeSkillEnabledIds()
      skillEnabledIdsSaved.value = [...normalizedIds]
      skillEnabledIdsDraft.value = [...normalizedIds]
      externalSkillDirsSaved.value = []
      externalSkillDirsDraft.value = []
      externalSkillItems.value = []
    }
  }

  function resetSkillSettingsDraft() {
    skillEnabledIdsDraft.value = [...skillEnabledIdsSaved.value]
    externalSkillDirsDraft.value = [...externalSkillDirsSaved.value]
    skillSearchKeyword.value = ''
    showSkillAddMenu.value = false
    skillSelectedMoreId.value = null
    showSkillDetail.value = false
    selectedSkillId.value = null
    showGithubImportModal.value = false
    githubSkillUrl.value = ''
    showRemoveSkillConfirm.value = false
    showDisableSkillConfirm.value = false
    skillPendingRemoval.value = null
    skillPendingDisable.value = null
    skillSettingsMessage.value = ''
    skillSettingsMessageLevel.value = 'warning'
  }

  function upsertExternalSkillItem(skill: SkillSettingsOption) {
    const nextDirs = new Set(externalSkillDirsDraft.value)
    if (skill.path) {
      nextDirs.add(normalizePath(skill.path))
    }
    externalSkillDirsDraft.value = Array.from(nextDirs)

    const nextItems = externalSkillItems.value.filter((item) => item.path !== skill.path)
    nextItems.push(skill)
    externalSkillItems.value = nextItems.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  function removeExternalSkillDirectory(dirPath: string) {
    const normalizedDir = normalizePath(dirPath)
    externalSkillDirsDraft.value = externalSkillDirsDraft.value.filter((item) => item !== normalizedDir)
    externalSkillItems.value = externalSkillItems.value.filter((item) => item.path !== normalizedDir)
  }

  async function importLocalSkillDirectory() {
    skillSettingsMessage.value = ''

    if (typeof window.electronAPI?.app.selectSkillDirectory !== 'function') {
      skillSettingsMessage.value = '当前运行的桌面程序版本过旧，请完整重启应用后再试'
      skillSettingsMessageLevel.value = 'error'
      return
    }

    try {
      const result = await window.electronAPI?.app.selectSkillDirectory()
      if (!result) {
        return
      }

      if (!result.isValid) {
        skillSettingsMessage.value = result.error || '导入失败，所选目录不是技能目录'
        skillSettingsMessageLevel.value = 'error'
        return
      }

      const nextSkill = toSkillOption(result)
      upsertExternalSkillItem(nextSkill)
      await persistSkillSettings(skillEnabledIdsDraft.value, externalSkillDirsDraft.value)
      skillSettingsMessage.value = `已添加技能：${nextSkill.name}`
      skillSettingsMessageLevel.value = 'success'
    } catch (error) {
      console.error('[Chat] 导入本地技能目录失败:', error)
      skillSettingsMessage.value =
        error instanceof Error ? error.message : '导入技能失败，请稍后重试'
      skillSettingsMessageLevel.value = 'error'
    }
  }

  async function confirmGithubSkillImport() {
    const repoUrl = githubSkillUrl.value.trim()
    if (!repoUrl || isImportingSkillFromGithub.value) {
      return
    }

    if (typeof window.electronAPI?.app.importSkillFromGitHub !== 'function') {
      skillSettingsMessage.value = '当前运行的桌面程序版本过旧，请完整重启应用后再试'
      skillSettingsMessageLevel.value = 'error'
      return
    }

    isImportingSkillFromGithub.value = true
    skillSettingsMessage.value = ''

    try {
      const result = await window.electronAPI?.app.importSkillFromGitHub(repoUrl)
      if (!result?.isValid) {
        skillSettingsMessage.value = result?.error || 'GitHub 导入失败'
        skillSettingsMessageLevel.value = 'error'
        return
      }

      upsertExternalSkillItem(toSkillOption(result))
      await persistSkillSettings(skillEnabledIdsDraft.value, externalSkillDirsDraft.value)
      closeGithubImportModal()
      skillSettingsMessage.value = `「${result.name}」导入成功`
      skillSettingsMessageLevel.value = 'success'
    } catch (error) {
      console.error('[Chat] GitHub 技能导入失败:', error)
      skillSettingsMessage.value =
        error instanceof Error ? error.message : 'GitHub 导入失败，请稍后重试'
      skillSettingsMessageLevel.value = 'error'
    } finally {
      isImportingSkillFromGithub.value = false
    }
  }

  async function toggleSkillEnabledImmediately(skill: SkillSettingsOption, enabled: boolean) {
    if (ALWAYS_ENABLED_SKILL_IDS.has(skill.id)) {
      return
    }

    const nextIds = new Set(skillEnabledIdsDraft.value)
    if (enabled) {
      nextIds.add(skill.id)
    } else {
      nextIds.delete(skill.id)
    }

    try {
      await persistSkillSettings(Array.from(nextIds), externalSkillDirsDraft.value)
      skillSettingsMessage.value = enabled ? `已启用技能「${skill.name}」` : `已关闭技能「${skill.name}」`
      skillSettingsMessageLevel.value = 'success'
    } catch (error) {
      console.error('[Chat] 更新技能启用状态失败:', error)
      skillSettingsMessage.value = error instanceof Error ? error.message : '更新技能状态失败'
      skillSettingsMessageLevel.value = 'error'
    }
  }

  function handleSkillCheckboxChange(skill: SkillSettingsOption, event: Event) {
    const target = event.target as HTMLInputElement | null
    const checked = !!target?.checked
    if (checked) {
      void toggleSkillEnabledImmediately(skill, true)
      return
    }

    skillPendingDisable.value = skill
    showDisableSkillConfirm.value = true
  }

  async function confirmDisableSkill() {
    const skill = skillPendingDisable.value
    if (!skill) {
      return
    }
    try {
      await toggleSkillEnabledImmediately(skill, false)
    } finally {
      showDisableSkillConfirm.value = false
      skillPendingDisable.value = null
    }
  }

  function requestRemoveSkill(skill: SkillSettingsOption) {
    skillPendingRemoval.value = skill
    showRemoveSkillConfirm.value = true
    skillSelectedMoreId.value = null
  }

  function requestRemoveSkillById(skillId: string | null) {
    const skill = getSkillById(skillId)
    if (!skill) {
      return
    }
    requestRemoveSkill(skill)
  }

  async function confirmRemoveSkill() {
    const skill = skillPendingRemoval.value
    if (!skill || !skill.path) {
      return
    }

    try {
      if (skill.source === 'user') {
        const result = await window.electronAPI?.app.removeManagedSkill(skill.id)
        if (!result?.success) {
          throw new Error(result?.message || '移除技能失败')
        }
      }

      removeExternalSkillDirectory(skill.path)
      await persistSkillSettings(skillEnabledIdsDraft.value, externalSkillDirsDraft.value)
      if (selectedSkillId.value === skill.id) {
        closeSkillDetail()
      }
      skillSettingsMessage.value = `已移除技能「${skill.name}」`
      skillSettingsMessageLevel.value = 'success'
    } catch (error) {
      console.error('[Chat] 移除技能失败:', error)
      skillSettingsMessage.value = error instanceof Error ? error.message : '移除技能失败'
      skillSettingsMessageLevel.value = 'error'
    } finally {
      showRemoveSkillConfirm.value = false
      skillPendingRemoval.value = null
    }
  }

  function setShowRemoveSkillConfirm(visible: boolean) {
    showRemoveSkillConfirm.value = visible
  }

  function setShowDisableSkillConfirm(visible: boolean) {
    showDisableSkillConfirm.value = visible
  }

  return {
    skillSearchKeyword,
    showSkillAddMenu,
    filteredSkillItems,
    skillSelectedMoreId,
    skillMoreMenuPosition,
    skillSettingsMessage,
    skillSettingsMessageLevel,
    showSkillDetail,
    selectedSkillItem,
    githubSkillUrl,
    isImportingSkillFromGithub,
    showGithubImportModal,
    showRemoveSkillConfirm,
    skillPendingRemoval,
    showDisableSkillConfirm,
    updateSkillSearchKeyword,
    clearSkillSearch,
    toggleSkillAddDropdown,
    openGithubImportModal,
    importLocalSkillDirectory,
    openSkillDetail,
    isSkillEnabled,
    handleSkillCheckboxChange,
    getSkillSourceLabel,
    isSkillRemovable,
    registerSkillMoreButton,
    toggleSkillMoreMenu,
    requestRemoveSkillById,
    closeSkillTransientUi,
    closeSkillDetail,
    requestRemoveSkill,
    closeGithubImportModal,
    updateGithubSkillUrl,
    confirmGithubSkillImport,
    confirmRemoveSkill,
    setShowRemoveSkillConfirm,
    confirmDisableSkill,
    setShowDisableSkillConfirm,
    loadSkillSettings,
    resetSkillSettingsDraft,
  }
}
