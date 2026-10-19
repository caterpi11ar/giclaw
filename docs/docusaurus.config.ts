import type * as Preset from '@docusaurus/preset-classic'
import type { Config } from '@docusaurus/types'
import { themes as prismThemes } from 'prism-react-renderer'

const config: Config = {
  title: 'giclaw',
  tagline: '视觉 AI + 可审计技能 + 自我迭代的《原神》云游戏奖励代理',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://giclaw.cn',
  baseUrl: '/',

  organizationName: 'caterpi11ar',
  projectName: 'giclaw',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/caterpi11ar/giclaw/tree/main/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'giclaw',
      logo: {
        alt: 'giclaw Logo',
        src: 'img/logo.jpeg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: '文档',
        },
        {
          to: '/docs/evolution',
          label: '自我迭代',
          position: 'left',
        },
        {
          to: '/docs/changelog',
          label: '更新日志',
          position: 'left',
        },
        {
          href: 'https://github.com/caterpi11ar/giclaw',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: '文档',
          items: [
            {
              label: '快速开始',
              to: '/docs/getting-started',
            },
            {
              label: '技能系统',
              to: '/docs/skills/overview',
            },
            {
              label: '上下文技能',
              to: '/docs/skills/context-skills',
            },
            {
              label: '自我迭代',
              to: '/docs/evolution',
            },
            {
              label: '更新日志',
              to: '/docs/changelog',
            },
          ],
        },
        {
          title: '更多',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/caterpi11ar/giclaw',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} giclaw. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
}

export default config
