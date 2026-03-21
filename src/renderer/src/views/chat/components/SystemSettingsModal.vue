<template>
  <div v-if="show" class="qclaw-modal-mask" @click.self="closeModal">
    <section class="qclaw-system-settings-modal">
      <header class="qclaw-model-modal-header">
        <h2>系统设置</h2>
        <button class="qclaw-modal-close" @click="closeModal">×</button>
      </header>

      <div class="qclaw-system-settings-body">
        <nav class="qclaw-system-settings-nav" aria-label="系统设置导航">
          <button
            v-for="tab in visibleTabs"
            :key="tab.key"
            type="button"
            :class="['qclaw-system-settings-nav-item', activeTab === tab.key && 'is-active']"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </nav>

        <div class="qclaw-system-settings-panel">
          <section v-if="activeTab === 'general'" class="qclaw-system-settings-section">
            <div class="qclaw-settings-panel-title">系统信息</div>
            <div class="qclaw-settings-panel-desc">
              左侧设置入口按最新版本的侧边栏底部布局恢复，功能入口收敛到这里统一管理。
            </div>

            <div class="qclaw-settings-overview-card">
              <div class="qclaw-settings-overview-item">
                <span class="qclaw-settings-overview-label">当前版本</span>
                <span class="qclaw-settings-overview-value">{{ systemSettingsVersion }}</span>
              </div>
              <div class="qclaw-settings-overview-item">
                <span class="qclaw-settings-overview-label">后台服务</span>
                <span class="qclaw-settings-overview-value">{{ systemSettingsGatewayLabel }}</span>
              </div>
              <div class="qclaw-settings-overview-item">
                <span class="qclaw-settings-overview-label">当前模式</span>
                <span class="qclaw-settings-overview-value">本地直连</span>
              </div>
            </div>

            <div class="qclaw-settings-general-actions">
              <button type="button" class="qclaw-settings-action-btn" @click="emit('open-model-settings')">
                大模型设置
              </button>
            </div>
          </section>

          <section v-else-if="activeTab === 'usage'" class="qclaw-system-settings-section">
            <div class="qclaw-settings-panel-title">用量统计</div>
            <div class="qclaw-settings-panel-desc">
              仅统计默认大模型的用量数据；不包含自定义模型数据
            </div>

            <div class="qclaw-usage-stat-grid">
              <article class="qclaw-usage-stat-card">
                <div class="qclaw-usage-stat-value">{{ usageStats.sessionCount }}</div>
                <div class="qclaw-usage-stat-label">总会话数</div>
              </article>
              <article class="qclaw-usage-stat-card">
                <div class="qclaw-usage-stat-value">{{ usageStats.messageCount }}</div>
                <div class="qclaw-usage-stat-label">当前会话消息数</div>
              </article>
              <article class="qclaw-usage-stat-card">
                <div class="qclaw-usage-stat-value">{{ usageStats.userMessageCount }}</div>
                <div class="qclaw-usage-stat-label">当前会话提问数</div>
              </article>
              <article class="qclaw-usage-stat-card">
                <div class="qclaw-usage-stat-value">{{ usageStats.gatewayStatus }}</div>
                <div class="qclaw-usage-stat-label">后台连接状态</div>
              </article>
            </div>

            <div class="qclaw-settings-overview-card qclaw-usage-detail-card">
              <div class="qclaw-usage-detail-header">当前统计说明</div>
              <div class="qclaw-usage-detail-copy">
                当前版本先展示桌面端可直接获取的会话与连接统计。默认模型的在线 Token 统计能力暂未在这套重建界面里单独开放，所以这里不会伪造一组不准确的数据。
              </div>
            </div>
          </section>

          <section v-else-if="activeTab === 'skills'" class="qclaw-system-settings-section">
            <div class="qclaw-settings-panel-title">技能管理</div>
            <div class="qclaw-settings-panel-desc">
              严格对齐最新版 App 的技能管理布局，支持搜索、通过对话创建、GitHub 导入与技能详情查看。
            </div>

            <div class="qclaw-skill-toolbar">
              <div class="qclaw-skill-search-box">
                <svg class="qclaw-skill-search-icon" viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="9" cy="9" r="6" />
                  <path d="M13.5 13.5L17 17" />
                </svg>
                <input
                  :value="skillSearchKeyword"
                  type="text"
                  class="qclaw-skill-search-input"
                  placeholder="搜索已经安装的技能"
                  @input="updateSkillSearchKeyword(($event.target as HTMLInputElement).value)"
                />
                <button
                  v-if="skillSearchKeyword"
                  type="button"
                  class="qclaw-skill-search-clear"
                  @click="clearSkillSearch"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="8" />
                    <path d="M5 5L11 11M11 5L5 11" />
                  </svg>
                </button>
              </div>

              <div ref="skillAddMenuRef" class="qclaw-skill-add-btn-wrapper">
                <button type="button" class="qclaw-skill-add-btn" @click="toggleSkillAddDropdown">
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M10 4V16M4 10H16" />
                  </svg>
                  <span class="qclaw-skill-add-btn-text">添加技能</span>
                </button>

                <div v-if="showSkillAddMenu" class="qclaw-skill-add-dropdown">
                  <button type="button" class="qclaw-skill-add-dropdown-item" @click="emit('request-create-skill-by-chat')">
                    <div class="qclaw-skill-add-dropdown-icon qclaw-skill-add-dropdown-icon-dark">+</div>
                    <div class="qclaw-skill-add-dropdown-text">
                      <span class="qclaw-skill-add-dropdown-title">通过对话创建</span>
                      <span class="qclaw-skill-add-dropdown-desc">描述你的需求，AI 帮你生成</span>
                    </div>
                  </button>
                  <button type="button" class="qclaw-skill-add-dropdown-item" @click="openGithubImportModal">
                    <div class="qclaw-skill-add-dropdown-icon">Git</div>
                    <div class="qclaw-skill-add-dropdown-text">
                      <span class="qclaw-skill-add-dropdown-title">从 GitHub 导入</span>
                      <span class="qclaw-skill-add-dropdown-desc">粘贴一个仓库链接以开始</span>
                    </div>
                  </button>
                  <button type="button" class="qclaw-skill-add-dropdown-item" @click="importLocalSkillDirectory">
                    <div class="qclaw-skill-add-dropdown-icon">Dir</div>
                    <div class="qclaw-skill-add-dropdown-text">
                      <span class="qclaw-skill-add-dropdown-title">从本地目录导入</span>
                      <span class="qclaw-skill-add-dropdown-desc">兼容导入已有本地技能目录</span>
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <div v-if="filteredSkillItems.length" class="qclaw-skill-grid">
              <article
                v-for="skill in filteredSkillItems"
                :key="`${skill.source}-${skill.id}-${skill.path || ''}`"
                class="qclaw-skill-card"
                @click="openSkillDetail(skill)"
              >
                <div class="qclaw-skill-card-top">
                  <div class="qclaw-skill-card-icon">
                    <span class="qclaw-skill-card-emoji">{{ skill.emoji }}</span>
                  </div>

                  <div class="qclaw-skill-card-info">
                    <div class="qclaw-skill-card-title">{{ skill.name }}</div>
                    <div class="qclaw-skill-card-desc">{{ skill.description || '暂无描述' }}</div>
                  </div>

                  <div class="qclaw-skill-card-switch" @click.stop>
                    <input
                      :checked="isSkillEnabled(skill.id)"
                      class="qclaw-skill-setting-checkbox"
                      type="checkbox"
                      :disabled="skill.alwaysEnabled"
                      @change="handleSkillCheckboxChange(skill, $event)"
                    />
                  </div>
                </div>

                <div class="qclaw-skill-card-divider"></div>

                <div class="qclaw-skill-card-bottom">
                  <div class="qclaw-skill-card-tags">
                    <span class="qclaw-skill-card-tag qclaw-skill-card-tag-category">
                      {{ getSkillSourceLabel(skill.source) }}
                    </span>
                    <span v-if="skill.version" class="qclaw-skill-card-tag qclaw-skill-card-tag-version">
                      v{{ skill.version }}
                    </span>
                  </div>

                  <div v-if="isSkillRemovable(skill)" class="qclaw-skill-card-more-wrapper" @click.stop>
                    <button
                      type="button"
                      class="qclaw-skill-card-more"
                      :ref="(element) => registerSkillMoreButton(skill.id, element)"
                      @click="toggleSkillMoreMenu(skill)"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="6" cy="12" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="18" cy="12" r="1.5" />
                      </svg>
                    </button>
                  </div>
                </div>
              </article>
            </div>

            <div v-else class="qclaw-skill-empty-state qclaw-skill-empty-state-rich">
              <div class="qclaw-skill-empty-image">
                <img :src="emptyStatusIcon" alt="暂无可用技能" />
              </div>
              <div class="qclaw-skill-empty-title">
                {{ skillSearchKeyword ? '没有找到匹配的技能' : '暂无可用技能' }}
              </div>
              <div class="qclaw-skill-empty-copy">
                {{ skillSearchKeyword ? '可以换个关键词继续搜索' : '通过对话创建或从 GitHub 导入新的技能' }}
              </div>
              <button type="button" class="qclaw-skill-empty-add-btn" @click="toggleSkillAddDropdown">
                添加技能
              </button>
            </div>

            <Teleport to="body">
              <div v-if="skillSelectedMoreId" class="qclaw-skill-more-menu" :style="skillMoreMenuPosition">
                <button
                  type="button"
                  class="qclaw-skill-more-menu-item"
                  @click="requestRemoveSkillById(skillSelectedMoreId)"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M3.5 5.5H16.5" />
                    <path d="M7.5 5.5V4C7.5 3.44772 7.94772 3 8.5 3H11.5C12.0523 3 12.5 3.44772 12.5 4V5.5" />
                    <path d="M5 5.5L5.5 16C5.5 16.5523 5.94772 17 6.5 17H13.5C14.0523 17 14.5 16.5523 14.5 16L15 5.5" />
                    <path d="M8.5 8.5V14" />
                    <path d="M11.5 8.5V14" />
                  </svg>
                  <span>移除</span>
                </button>
              </div>
            </Teleport>

            <div v-if="skillSettingsMessage" :class="['qclaw-form-message', `is-${skillSettingsMessageLevel}`]">
              {{ skillSettingsMessage }}
            </div>

            <div v-if="showSkillDetail && selectedSkillItem" class="qclaw-skill-detail-mask" @click.self="closeSkillDetail">
              <section class="qclaw-skill-detail-panel">
                <button type="button" class="qclaw-modal-close qclaw-skill-detail-close" @click="closeSkillDetail">×</button>
                <div class="qclaw-skill-detail-header">
                  <div class="qclaw-skill-detail-icon">{{ selectedSkillItem.emoji }}</div>
                  <div class="qclaw-skill-detail-header-info">
                    <div class="qclaw-skill-detail-name">{{ selectedSkillItem.name }}</div>
                    <div class="qclaw-skill-detail-meta">
                      <span v-if="selectedSkillItem.version" class="qclaw-skill-detail-version">
                        v{{ selectedSkillItem.version }}
                      </span>
                      <span class="qclaw-skill-detail-tag">
                        {{ getSkillSourceLabel(selectedSkillItem.source) }}
                      </span>
                    </div>
                  </div>
                </div>

                <div class="qclaw-skill-detail-description">
                  {{ selectedSkillItem.fullDescription || selectedSkillItem.description || '暂无详细描述' }}
                </div>
                <div v-if="selectedSkillItem.path" class="qclaw-skill-detail-source">
                  {{ selectedSkillItem.path }}
                </div>

                <div v-if="isSkillRemovable(selectedSkillItem)" class="qclaw-skill-detail-actions">
                  <button type="button" class="qclaw-skill-detail-remove-btn" @click="requestRemoveSkill(selectedSkillItem)">
                    移除
                  </button>
                </div>
              </section>
            </div>

            <div v-if="showGithubImportModal" class="qclaw-skill-dialog-mask" @click.self="closeGithubImportModal">
              <section class="qclaw-skill-dialog">
                <button type="button" class="qclaw-modal-close" @click="closeGithubImportModal">×</button>
                <div class="qclaw-skill-dialog-title">从 GitHub 导入</div>
                <div class="qclaw-skill-dialog-desc">直接从公开的 GitHub 仓库中导入技能</div>
                <div class="qclaw-github-import-field">
                  <span class="qclaw-github-import-label">URL：</span>
                  <input
                    :value="githubSkillUrl"
                    type="text"
                    class="qclaw-github-import-input"
                    placeholder="请输入"
                    @input="updateGithubSkillUrl(($event.target as HTMLInputElement).value)"
                    @keydown.enter.prevent="confirmGithubSkillImport"
                  />
                </div>
                <div class="qclaw-skill-dialog-actions">
                  <button
                    type="button"
                    class="qclaw-skill-dialog-btn-primary"
                    :disabled="!githubSkillUrl || isImportingSkillFromGithub"
                    @click="confirmGithubSkillImport"
                  >
                    {{ isImportingSkillFromGithub ? '导入中...' : '导入' }}
                  </button>
                  <button type="button" class="qclaw-skill-dialog-btn-secondary" @click="closeGithubImportModal">
                    取消
                  </button>
                </div>
              </section>
            </div>

            <div v-if="showRemoveSkillConfirm" class="qclaw-skill-dialog-mask" @click.self="setShowRemoveSkillConfirm(false)">
              <section class="qclaw-skill-dialog qclaw-skill-dialog-compact">
                <div class="qclaw-skill-dialog-title">确认移除该技能？</div>
                <div class="qclaw-skill-dialog-desc">
                  {{ skillPendingRemoval?.source === 'user' ? '移除后将删除本地技能文件，此操作不可恢复，请谨慎操作。' : '移除后将从当前配置中删除该技能引用。' }}
                </div>
                <div class="qclaw-skill-dialog-actions">
                  <button type="button" class="qclaw-skill-dialog-btn-primary" @click="confirmRemoveSkill">移除</button>
                  <button type="button" class="qclaw-skill-dialog-btn-secondary" @click="setShowRemoveSkillConfirm(false)">取消</button>
                </div>
              </section>
            </div>

            <div v-if="showDisableSkillConfirm" class="qclaw-skill-dialog-mask" @click.self="setShowDisableSkillConfirm(false)">
              <section class="qclaw-skill-dialog qclaw-skill-dialog-compact">
                <div class="qclaw-skill-dialog-title">确认关闭该技能？</div>
                <div class="qclaw-skill-dialog-desc">
                  关闭此技能会影响对话任务正常使用，可能导致输出效果不佳，请谨慎操作。
                </div>
                <div class="qclaw-skill-dialog-actions">
                  <button type="button" class="qclaw-skill-dialog-btn-primary" @click="confirmDisableSkill">关闭</button>
                  <button type="button" class="qclaw-skill-dialog-btn-secondary" @click="setShowDisableSkillConfirm(false)">取消</button>
                </div>
              </section>
            </div>
          </section>

          <section v-else-if="activeTab === 'remote'" class="qclaw-system-settings-section">
            <div class="qclaw-settings-panel-title">远控通道</div>
            <div class="qclaw-settings-panel-desc">
              接入远控通道，用户可以直接在聊天工具中与 QClaw 对话交互
            </div>

            <div class="qclaw-remote-channel-grid">
              <article
                v-for="channel in remoteChannelCards"
                :key="channel.id"
                class="qclaw-remote-channel-card"
              >
                <div class="qclaw-remote-channel-card-header">
                  <div class="qclaw-remote-channel-card-icon">{{ channel.icon }}</div>
                  <div class="qclaw-remote-channel-card-copy">
                    <div class="qclaw-remote-channel-card-name">
                      {{ channel.name }}
                      <span v-if="channel.recommended" class="qclaw-remote-channel-tag">推荐</span>
                    </div>
                    <div class="qclaw-remote-channel-card-desc">{{ channel.description }}</div>
                  </div>
                </div>

                <div class="qclaw-remote-channel-card-footer">
                  <template v-if="channel.status === 'connected'">
                    <button type="button" class="qclaw-remote-channel-config-btn" @click="emit('open-remote-channel', channel.id)">
                      查看配置
                    </button>
                    <button
                      type="button"
                      class="qclaw-remote-channel-status-tag is-connected"
                      @click="emit('open-remote-channel', channel.id)"
                    >
                      {{ channel.connectedLabel }}
                    </button>
                  </template>

                  <template v-else-if="channel.status === 'available'">
                    <button type="button" class="qclaw-remote-channel-config-btn" @click="emit('open-remote-channel', channel.id)">
                      配置
                    </button>
                  </template>

                  <template v-else>
                    <span class="qclaw-remote-channel-status-tag is-disabled">即将支持</span>
                  </template>
                </div>
              </article>
            </div>
          </section>

          <section v-else-if="activeTab === 'about'" class="qclaw-system-settings-section">
            <div class="qclaw-about-section">
              <div class="qclaw-about-logo-area">
                <img :src="qmIcon" alt="QClaw" class="qclaw-about-logo" />
                <span class="qclaw-about-app-name">QClaw</span>
              </div>

              <div class="qclaw-about-card-list">
                <article class="qclaw-about-card">
                  <div class="qclaw-about-card-row">
                    <div class="qclaw-about-card-main">
                      <span class="qclaw-about-card-label">当前版本</span>
                      <span class="qclaw-about-card-version">{{ systemSettingsVersion }}</span>
                      <span v-if="hasNewVersion" class="qclaw-about-update-tag">可更新</span>
                    </div>
                    <div class="qclaw-about-card-actions">
                      <button type="button" class="qclaw-about-action-btn" @click="checkForUpdates">
                        检查更新
                      </button>
                      <button type="button" class="qclaw-about-action-btn is-secondary" @click="activeTab = 'release-note'">
                        版本日志
                      </button>
                    </div>
                  </div>
                </article>

                <button type="button" class="qclaw-about-card qclaw-about-card-link" @click="openOfficialSite">
                  <div class="qclaw-about-card-row">
                    <span class="qclaw-about-card-label">进入官网</span>
                    <span class="qclaw-about-card-arrow">›</span>
                  </div>
                </button>
              </div>

              <div v-if="aboutMessage" :class="['qclaw-form-message', `is-${aboutMessageLevel}`]">
                {{ aboutMessage }}
              </div>
            </div>
          </section>

          <section v-else-if="activeTab === 'release-note'" class="qclaw-system-settings-section">
            <div class="qclaw-release-note-header-row">
              <div>
                <div class="qclaw-settings-panel-title">版本日志</div>
                <div class="qclaw-settings-panel-desc">
                  按安装包中最新版本记录整理最近几次更新内容。
                </div>
              </div>
              <button type="button" class="qclaw-about-action-btn is-secondary" @click="activeTab = 'about'">
                返回
              </button>
            </div>

            <div class="qclaw-release-note-list">
              <article v-for="note in releaseNotes" :key="note.version" class="qclaw-release-note-card">
                <div class="qclaw-release-note-card-header">
                  <div class="qclaw-release-note-title">v{{ note.version }}</div>
                  <div class="qclaw-release-note-date">{{ note.date }}</div>
                </div>
                <div class="qclaw-release-note-summary">{{ note.summary }}</div>
                <ul class="qclaw-release-note-items">
                  <li v-for="item in note.items" :key="item">{{ item }}</li>
                </ul>
              </article>
            </div>
          </section>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import emptyStatusIcon from '../../../../assets/empty-status.svg'
import qmIcon from '../../../../assets/qm-icon.png'
import {
  RELEASE_NOTES,
  SYSTEM_SETTINGS_TABS,
  type MessageLevel,
  type RemoteChannelCard,
  type SystemSettingsTabKey,
  type UsageStats,
} from '../system-settings'
import { useSkillSettingsPanel } from '../use-skill-settings-panel'

const props = defineProps<{
  show: boolean
  initialTab?: SystemSettingsTabKey
  checkUpdatesOnOpen?: boolean
  systemSettingsVersion: string
  systemSettingsGatewayLabel: string
  usageStats: UsageStats
  remoteChannelCards: RemoteChannelCard[]
  openOfficialSite: () => void
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'open-model-settings'): void
  (event: 'open-remote-channel', channelId: string): void
  (event: 'request-create-skill-by-chat'): void
}>()

const skillAddMenuRef = ref<HTMLElement | null>(null)
const activeTab = ref<SystemSettingsTabKey>('general')
const aboutMessage = ref('')
const aboutMessageLevel = ref<MessageLevel>('success')

const {
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
} = useSkillSettingsPanel()

const visibleTabs = computed(() => SYSTEM_SETTINGS_TABS.filter((item) => item.visible !== false))
const releaseNotes = RELEASE_NOTES
const latestReleaseVersion = computed(() => RELEASE_NOTES[0]?.version ?? '0.1.13')
const hasNewVersion = computed(() => compareVersions(latestReleaseVersion.value, props.systemSettingsVersion) > 0)

function compareVersions(left: string, right: string) {
  const leftParts = left.replace(/^v/i, '').split('.').map((item) => Number(item) || 0)
  const rightParts = right.replace(/^v/i, '').split('.').map((item) => Number(item) || 0)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0
    const rightValue = rightParts[index] ?? 0
    if (leftValue > rightValue) {
      return 1
    }
    if (leftValue < rightValue) {
      return -1
    }
  }

  return 0
}

function checkForUpdates() {
  if (hasNewVersion.value) {
    aboutMessage.value = `发现可用版本 v${latestReleaseVersion.value}，可查看版本日志了解更新内容。`
    aboutMessageLevel.value = 'success'
    return
  }

  aboutMessage.value = `当前已是最新版本（${props.systemSettingsVersion}）。`
  aboutMessageLevel.value = 'success'
}

function closeModal() {
  emit('close')
}

function handlePointerDown(event: PointerEvent) {
  if (!props.show || activeTab.value !== 'skills') {
    return
  }

  const target = event.target as Node | null
  if (skillAddMenuRef.value?.contains(target)) {
    return
  }

  if (target instanceof Element && target.closest('.qclaw-skill-more-menu')) {
    return
  }

  closeSkillTransientUi()
}

watch(
  () => props.show,
  async (visible) => {
    if (visible) {
      activeTab.value = props.initialTab ?? 'general'
      aboutMessage.value = ''
      aboutMessageLevel.value = 'success'
      await loadSkillSettings()
      if (props.checkUpdatesOnOpen && activeTab.value === 'about') {
        checkForUpdates()
      }
      return
    }

    resetSkillSettingsDraft()
    aboutMessage.value = ''
  },
  { immediate: true },
)

watch(
  () => props.initialTab,
  (tab) => {
    if (props.show && tab) {
      activeTab.value = tab
    }
  },
)

onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown)
})
</script>
