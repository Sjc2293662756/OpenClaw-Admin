<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

type EntryType = 'chat' | 'config'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

function enterPlatform(entry: EntryType) {
  // 入口卡片代表用户主动选择工作空间，不能被退出登录时遗留的 redirect 覆盖。
  const redirect = entry === 'config' ? '/' : '/workspace'
  router.push({ name: 'Login', query: { redirect, entry } })
}
</script>

<template>
  <main class="entrance-page">
    <div class="ambient ambient-top"></div>
    <div class="ambient ambient-bottom"></div>

    <header class="entrance-header">
      <div class="brand-lockup" :aria-label="`${t('pages.gaiop.entrance.company')} NetInside`">
        <span class="brand-logo" aria-label="NetInside">
          <span class="brand-logo-net">Net</span><span>Inside</span>
        </span>
        <span class="brand-divider"></span>
        <span class="brand-product">{{ t('pages.gaiop.entrance.product') }}</span>
      </div>

      <div class="company-name">
        <span>{{ t('pages.gaiop.entrance.company') }}</span>
        <span class="company-dot">·</span>
        <span>NetInside</span>
      </div>
    </header>

    <section class="entrance-content" aria-labelledby="platform-title">
      <div class="platform-intro">
        <p class="eyebrow">NETINSIDE INTELLIGENT OPERATIONS</p>
        <h1 id="platform-title">{{ t('pages.gaiop.entrance.product') }}</h1>
        <p class="platform-full-name">{{ t('pages.gaiop.entrance.fullName') }}</p>
        <p class="platform-description">{{ t('pages.gaiop.entrance.description') }}</p>

        <div class="entry-cards">
          <button type="button" class="entry-card" @click="enterPlatform('chat')">
            <span class="card-icon card-icon-chat" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M20 11.5a7.5 7.5 0 0 1-8 7.49 8.26 8.26 0 0 1-3.49-.83L4 19.5l1.25-3.24A7.13 7.13 0 0 1 4.5 13.5 7.5 7.5 0 0 1 12 6c4.42 0 8 2.46 8 5.5Z" />
                <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" stroke-linecap="round" stroke-width="2.5" />
              </svg>
            </span>
            <span class="card-content">
              <strong>{{ t('pages.gaiop.entrance.chatTitle') }}</strong>
              <small>{{ t('pages.gaiop.entrance.chatDescription') }}</small>
            </span>
            <span class="card-arrow" aria-hidden="true">→</span>
          </button>

          <button type="button" class="entry-card" @click="enterPlatform('config')">
            <span class="card-icon card-icon-config" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
                <path d="m19.4 15 .1 1.7-2.02 1.16-1.4-1a7.1 7.1 0 0 1-1.47.85l-.3 1.7h-2.34l-.3-1.7a7.1 7.1 0 0 1-1.47-.85l-1.4 1L6.6 16.7 6.7 15a6.6 6.6 0 0 1 0-1.7l-1.5-.86L6.6 10.1l1.4 1c.46-.35.96-.64 1.47-.85l.3-1.7h2.34l.3 1.7c.51.21 1.01.5 1.47.85l1.4-1 2.02 1.16-1.5.86a6.6 6.6 0 0 1 0 1.7Z" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="card-content">
              <strong>{{ t('pages.gaiop.entrance.configTitle') }}</strong>
              <small>{{ t('pages.gaiop.entrance.configDescription') }}</small>
            </span>
            <span class="card-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <aside class="company-card" :aria-label="t('pages.gaiop.entrance.companyTitle')">
        <div class="card-grid"></div>
        <div class="orbit orbit-one"></div>
        <div class="orbit orbit-two"></div>
        <div class="node node-one"></div>
        <div class="node node-two"></div>
        <div class="company-card-content">
          <p class="company-card-label">BEIJING WANGSHEN TECHNOLOGY</p>
          <h2>{{ t('pages.gaiop.entrance.companyTitle') }}</h2>
          <p>{{ t('pages.gaiop.entrance.companyDescription') }}</p>
          <span class="company-card-link">{{ t('pages.gaiop.entrance.companyLink') }} <b>→</b></span>
        </div>
      </aside>
    </section>

    <footer class="entrance-footer">© {{ new Date().getFullYear() }} {{ t('pages.gaiop.entrance.company') }}</footer>
  </main>
</template>

<style scoped>
.entrance-page {
  --brand-green: #37a96b;
  --brand-green-deep: #087249;
  --ink: #173e31;
  --muted: #5f8475;
  min-height: 100vh;
  overflow: hidden;
  position: relative;
  box-sizing: border-box;
  padding: 28px clamp(28px, 5.2vw, 96px) 24px;
  background:
    radial-gradient(circle at 87% 15%, rgba(92, 207, 149, 0.18), transparent 25%),
    radial-gradient(circle at 4% 100%, rgba(79, 185, 133, 0.14), transparent 31%),
    linear-gradient(116deg, #fcfefc 0%, #f5fbf7 49%, #ecf9f1 100%);
  color: var(--ink);
  font-family: Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.ambient {
  border-radius: 999px;
  filter: blur(2px);
  pointer-events: none;
  position: absolute;
}

.ambient-top {
  width: 48vw;
  height: 48vw;
  right: -21vw;
  top: -30vw;
  border: 1px solid rgba(55, 169, 107, 0.13);
}

.ambient-bottom {
  width: 45vw;
  height: 45vw;
  left: -28vw;
  bottom: -34vw;
  border: 1px solid rgba(67, 167, 90, 0.11);
}

.entrance-header,
.entrance-content,
.entrance-footer {
  position: relative;
  z-index: 1;
}

.entrance-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-inline: -34px;
}

.brand-lockup {
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: 0;
}

.brand-logo {
  color: #171e1b;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.045em;
  line-height: 1;
  white-space: nowrap;
}

.brand-logo-net {
  color: #50ae65;
}

.brand-divider {
  width: 1px;
  height: 23px;
  background: rgba(25, 50, 75, 0.2);
}

.brand-product {
  color: #174d38;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.company-name {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #5b806f;
  font-size: 14px;
  white-space: nowrap;
}

.company-dot {
  color: var(--brand-green);
}

.entrance-content {
  width: min(100%, 1160px);
  min-height: calc(100vh - 130px);
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(340px, 0.78fr);
  align-items: center;
  gap: clamp(44px, 9vw, 152px);
  padding: clamp(52px, 9vh, 120px) 0 70px;
}

.platform-intro {
  max-width: 620px;
}

.eyebrow {
  margin: 0 0 18px;
  color: var(--brand-green-deep);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.14em;
}

h1 {
  margin: 0;
  color: #1b4937;
  font-size: clamp(48px, 5.2vw, 76px);
  font-weight: 680;
  line-height: 1.05;
  letter-spacing: -0.055em;
}

h1 span {
  color: var(--brand-green);
  font-weight: 720;
}

.platform-full-name {
  margin: 20px 0 0;
  color: #215940;
  font-size: clamp(21px, 2.1vw, 30px);
  font-weight: 500;
  letter-spacing: 0.01em;
}

.platform-description {
  max-width: 510px;
  margin: 18px 0 0;
  color: var(--muted);
  font-size: 15px;
  line-height: 1.8;
}

.entry-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  margin-top: 48px;
}

.entry-card {
  min-height: 154px;
  padding: 24px 21px;
  border: 1px solid rgba(48, 139, 91, 0.14);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.77);
  box-shadow: 0 16px 35px rgba(55, 126, 84, 0.08);
  color: inherit;
  cursor: pointer;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 13px;
  text-align: left;
  transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
}

.entry-card:hover {
  transform: translateY(-5px);
  border-color: rgba(55, 169, 107, 0.34);
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 22px 42px rgba(48, 133, 83, 0.15);
}

.entry-card:focus-visible {
  outline: 3px solid rgba(55, 169, 107, 0.28);
  outline-offset: 3px;
}

.card-icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 11px;
}

.card-icon svg {
  width: 20px;
  height: 20px;
}

.card-icon-chat {
  color: var(--brand-green-deep);
  background: #e5f8ed;
}

.card-icon-config {
  color: var(--brand-green-deep);
  background: #e5f8ed;
}

.card-content {
  display: grid;
  gap: 10px;
}

.card-content strong {
  color: var(--brand-green-deep);
  font-size: 18px;
  font-weight: 600;
}

.card-content small {
  color: #70849a;
  font-size: 13px;
  line-height: 1.65;
}

.card-arrow {
  color: #89a1ba;
  font-size: 20px;
  line-height: 1;
  transition: transform 180ms ease, color 180ms ease;
}

.entry-card:hover .card-arrow {
  color: var(--brand-green);
  transform: translateX(3px);
}

.company-card {
  min-height: 325px;
  overflow: hidden;
  position: relative;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 22px;
  background:
    radial-gradient(circle at 85% 84%, rgba(96, 222, 154, 0.3), transparent 29%),
    linear-gradient(135deg, #0b7552 0%, #078356 58%, #20a36d 100%);
  box-shadow: 0 27px 55px rgba(22, 105, 67, 0.22);
  color: white;
}

.company-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(130deg, rgba(255, 255, 255, 0.08), transparent 39%);
}

.card-grid {
  position: absolute;
  inset: -44px -37px;
  opacity: 0.22;
  background-image: linear-gradient(rgba(255, 255, 255, 0.27) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.27) 1px, transparent 1px);
  background-size: 38px 38px;
  transform: perspective(480px) rotateX(56deg) rotateZ(-7deg) scale(1.22);
  transform-origin: center bottom;
}

.orbit {
  position: absolute;
  border: 1px solid rgba(226, 255, 247, 0.5);
  border-radius: 50%;
}

.orbit-one {
  right: -95px;
  top: 24px;
  width: 285px;
  height: 285px;
}

.orbit-two {
  right: -46px;
  top: 73px;
  width: 188px;
  height: 188px;
}

.node {
  position: absolute;
  width: 9px;
  height: 9px;
  border: 2px solid rgba(255, 255, 255, 0.7);
  border-radius: 50%;
  box-shadow: 0 0 18px rgba(191, 255, 229, 0.8);
}

.node-one { right: 62px; top: 73px; }
.node-two { right: 127px; bottom: 71px; }

.company-card-content {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  min-height: 325px;
  justify-content: flex-end;
  box-sizing: border-box;
  padding: 34px;
}

.company-card-label {
  margin: 0 0 14px;
  color: rgba(236, 255, 250, 0.72);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
}

.company-card h2 {
  margin: 0;
  color: white;
  font-size: 31px;
  font-weight: 600;
  letter-spacing: -0.03em;
}

.company-card-content > p:not(.company-card-label) {
  max-width: 270px;
  margin: 12px 0 20px;
  color: rgba(246, 255, 253, 0.87);
  font-size: 13px;
  line-height: 1.75;
}

.company-card-link {
  color: white;
  font-size: 14px;
  font-weight: 500;
}

.company-card-link b {
  display: inline-block;
  margin-left: 4px;
  font-size: 17px;
  transition: transform 180ms ease;
}

.company-card:hover .company-card-link b { transform: translateX(4px); }

.entrance-footer {
  color: rgba(67, 111, 87, 0.72);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 900px) {
  .entrance-content {
    grid-template-columns: 1fr;
    gap: 42px;
    padding-top: 70px;
  }

  .platform-intro { max-width: none; }
  .company-card { max-width: 560px; width: 100%; }
}

@media (max-width: 620px) {
  .entrance-page { padding: 22px 22px 20px; }
  .entrance-header { align-items: flex-start; margin-inline: 0; }
  .company-name { display: none; }
  .brand-logo { font-size: 15px; }
  .brand-product { font-size: 14px; }
  .entrance-content { min-height: auto; padding: 60px 0 52px; }
  .platform-full-name { font-size: 21px; line-height: 1.45; }
  .entry-cards { grid-template-columns: 1fr; margin-top: 36px; }
  .entry-card { min-height: 126px; }
  .company-card, .company-card-content { min-height: 285px; }
  .company-card-content { padding: 27px; }
  .company-card h2 { font-size: 27px; }
}
</style>
