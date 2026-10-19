import type { ReactNode } from 'react'
import Link from '@docusaurus/Link'
import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import Heading from '@theme/Heading'
import Layout from '@theme/Layout'

import styles from './index.module.css'

const features = [
  {
    title: '视觉 + 确定性执行',
    icon: '🎮',
    description: '22 个原子操作：视觉模型定位变化界面，确定性键鼠回放稳定入口，步骤可审计、可复现。',
  },
  {
    title: '文件驱动技能',
    icon: '⚡',
    description: '每个技能就是一个 SKILL.md；支持依赖展开、命名流程和启动时的严格校验。',
  },
  {
    title: '共享游戏上下文',
    icon: '🧠',
    description: '16 个标签化上下文技能（UI / 地图 / 任务 / 战斗 / 奖励 / 安全…），按需注入每个任务，不必重复写背景。',
  },
  {
    title: '自我迭代进化',
    icon: '🔁',
    description: 'giclaw evolve 从真实失败证据出发，产出最小 SKILL.md 补丁，硬门禁校验后真实重跑，失败自动回滚。',
  },
  {
    title: '可审计证据',
    icon: '📸',
    description: '成功领取后的截图检查点、失败现场截图、逐步 JSONL transcript 与运行摘要，全部落盘可查。',
  },
  {
    title: '云游戏与连接器',
    icon: '☁️',
    description: '无需本地客户端；飞书、邮件、Webhook 连接器把结果推出去，也能把外部信号拉进来。',
  },
]

function HomepageHero() {
  const { siteConfig } = useDocusaurusContext()
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroContent}>
          <span className={styles.heroBadge}>开源 · 视觉 AI · 云游戏</span>
          <Heading as="h1" className={styles.heroTitle}>
            {siteConfig.title}
          </Heading>
          <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
          <div className={styles.heroButtons}>
            <Link className={styles.primaryButton} to="/docs/getting-started">
              快速开始
            </Link>
            <Link
              className={styles.secondaryButton}
              href="https://github.com/caterpi11ar/giclaw"
            >
              GitHub
            </Link>
          </div>
          <div className={styles.heroHighlights}>
            <div className={styles.highlight}>
              <span className={styles.highlightIcon}>🎮</span>
              <span className={styles.highlightText}>5 项奖励流程已验收</span>
            </div>
            <div className={styles.highlight}>
              <span className={styles.highlightIcon}>⚡</span>
              <span className={styles.highlightText}>22 个原子操作</span>
            </div>
            <div className={styles.highlight}>
              <span className={styles.highlightIcon}>🧠</span>
              <span className={styles.highlightText}>16 个共享上下文技能</span>
            </div>
            <div className={styles.highlight}>
              <span className={styles.highlightIcon}>🔁</span>
              <span className={styles.highlightText}>自我迭代 loop</span>
            </div>
          </div>
        </div>

        <div className={styles.heroVisual}>
          <div className={styles.logoContainer}>
            <div className={`${styles.energyRing} ${styles.ring1}`} />
            <div className={`${styles.energyRing} ${styles.ring2}`} />
            <div className={`${styles.energyRing} ${styles.ring3}`} />
            <img
              src="/img/logo.jpeg"
              alt="giclaw Logo"
              className={styles.logo}
            />
          </div>
        </div>
      </div>
    </header>
  )
}

function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className={styles.featuresInner}>
        <Heading as="h2" className={styles.sectionTitle}>
          为什么选择 giclaw
        </Heading>
        <div className={styles.featuresCard}>
          {features.map(({ title, icon, description }, idx) => (
            <div
              key={idx}
              className={styles.featureCell}
              style={{ animationDelay: `${idx * 0.1}s` }}
            >
              <div className={styles.featureDecorator}>
                <div className={styles.decoratorGrid} />
                <div className={styles.decoratorIcon}>{icon}</div>
              </div>
              <Heading as="h3" className={styles.featureTitle}>
                {title}
              </Heading>
              <p className={styles.featureDescription}>{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function HomepageCta() {
  return (
    <section className={styles.cta}>
      <div className={styles.ctaBox}>
        <Heading as="h2" className={styles.ctaTitle}>
          开始你的自动化之旅
        </Heading>
        <p className={styles.ctaDescription}>
          五分钟完成配置，让 AI 代理处理重复性的奖励领取
        </p>
        <div className={styles.ctaButtons}>
          <Link className={styles.primaryButton} to="/docs/getting-started">
            快速开始
          </Link>
          <Link className={styles.ctaOutlineButton} to="/docs/skills/overview">
            技能开发
          </Link>
          <Link className={styles.ctaOutlineButton} to="/docs/evolution">
            自我迭代
          </Link>
          <Link
            className={styles.ctaOutlineButton}
            href="https://github.com/caterpi11ar/giclaw"
          >
            GitHub
          </Link>
        </div>
      </div>
    </section>
  )
}

export default function Home(): ReactNode {
  return (
    <Layout description="视觉 AI + 可审计技能 + 自我迭代的《原神》云游戏奖励代理">
      <div className={styles.pageWrapper}>
        <div className={styles.bgGrid} />
        <div className={`${styles.bgBlob} ${styles.bgBlob1}`} />
        <div className={`${styles.bgBlob} ${styles.bgBlob2}`} />
        <div className={`${styles.bgBlob} ${styles.bgBlob3}`} />

        <HomepageHero />
        <HomepageFeatures />
        <HomepageCta />
      </div>
    </Layout>
  )
}
