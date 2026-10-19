import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { TaskRunner } from '../tasks/task-runner.js'
import { loadSkills } from './loader.js'
import { SkillRegistry } from './registry.js'
import { STEP_METHODS } from './types.js'

describe('built-in skill contracts', () => {
  it('loads the exact catalog with verified defaults and dependencies', async () => {
    const skills = await loadSkills([resolve('skills')])
    const runnable = skills.filter(skill => !skill.context)
    const catalog = Object.fromEntries(runnable.map(skill => [skill.id, {
      enabled: skill.enabled,
      retries: skill.retries,
      dependsOn: skill.dependsOn,
      steps: skill.steps.length,
    }]))

    expect(catalog).toEqual({
      'battle-pass-claim': { enabled: true, retries: 0, dependsOn: ['welkin-moon'], steps: 9 },
      'claim-achievements': { enabled: true, retries: 0, dependsOn: ['welkin-moon'], steps: 9 },
      'claim-event-rewards': { enabled: true, retries: 0, dependsOn: ['welkin-moon'], steps: 8 },
      'claim-mail': { enabled: true, retries: 0, dependsOn: ['welkin-moon'], steps: 13 },
      'expedition-collect': { enabled: false, retries: 0, dependsOn: ['welkin-moon'], steps: 35 },
      'welkin-moon': { enabled: true, retries: 0, dependsOn: [], steps: 21 },
    })
    expect(Object.values(catalog).every(item => item.steps > 0)).toBe(true)
    expect(skills.flatMap(skill => skill.steps).every(step => STEP_METHODS.includes(step.method))).toBe(true)

    const contextIds = skills.filter(skill => skill.context).map(skill => skill.id).sort()
    expect(contextIds).toEqual([
      'genshin-automation-pitfalls',
      'genshin-basics',
      'genshin-characters',
      'genshin-cloud',
      'genshin-combat',
      'genshin-events',
      'genshin-gear',
      'genshin-interaction-safety',
      'genshin-map',
      'genshin-navigation',
      'genshin-progression',
      'genshin-quests',
      'genshin-rewards',
      'genshin-shop',
      'genshin-social',
      'genshin-ui',
    ])
    expect(skills.filter(skill => skill.context).every(skill => skill.steps.length === 0)).toBe(true)
  })

  it('scopes context injection by tag', async () => {
    const skills = await loadSkills([resolve('skills')])
    const welkin = skills.find(skill => skill.id === 'welkin-moon')!
    const mail = skills.find(skill => skill.id === 'claim-mail')!
    // welkin-moon asks for `ui`, not `reward`.
    expect(welkin.background).not.toContain('原神可领取奖励的入口与语义')
    expect(mail.background).toContain('原神可领取奖励的入口与语义')
    // `core` is always injected.
    expect(welkin.background).toContain('原神（Genshin Impact）')
  })

  it('injects context skills into runnable skills and never runs them', async () => {
    const skills = await loadSkills([resolve('skills')])
    const mail = skills.find(skill => skill.id === 'claim-mail')!
    expect(mail.background).toContain('原神（Genshin Impact）')
    expect(mail.background).toContain('原神 HUD 与菜单布局')
    expect(mail.knownIssues?.join('\n')).toContain('云游戏画面可能处于加载')

    const registry = new SkillRegistry()
    await registry.loadFromDirs([resolve('skills')])
    const taskIds = registry.toTaskDefinitions().map(task => task.id)
    expect(taskIds).toContain('claim-mail')
    expect(taskIds).not.toContain('genshin-basics')
  })

  it('locks the reviewed operation order for every built-in skill', async () => {
    const skills = await loadSkills([resolve('skills')])
    const methods = Object.fromEntries(skills.filter(skill => !skill.context).map(skill => [
      skill.id,
      skill.steps.map(step => step.method),
    ]))

    expect(methods).toEqual({
      'battle-pass-claim': ['keyPress', 'aiWaitFor', 'aiTap', 'aiWaitFor', 'aiAct', 'screenshot', 'aiAct', 'keyPress', 'aiWaitFor'],
      'claim-achievements': ['keyPress', 'aiWaitFor', 'aiTap', 'aiWaitFor', 'aiAct', 'screenshot', 'aiAct', 'keyPress', 'aiAct'],
      'claim-event-rewards': ['keyPress', 'aiAct', 'aiWaitFor', 'aiAct', 'screenshot', 'aiAct', 'keyPress', 'aiAct'],
      'claim-mail': ['keyPress', 'aiWaitFor', 'aiTap', 'aiAct', 'aiWaitFor', 'aiAssert', 'aiAct', 'screenshot', 'aiAct', 'keyPress', 'wait', 'keyPress', 'aiWaitFor'],
      'expedition-collect': [
        'keyPress',
        'aiWaitFor',
        'aiAct',
        'aiWaitFor',
        'click',
        'aiWaitFor',
        'aiTap',
        'aiWaitFor',
        'aiAct',
        'aiWaitFor',
        'keyDown',
        'wait',
        'keyUp',
        'aiWaitFor',
        'move',
        'mouseDown',
        'wait',
        'move',
        'wait',
        'mouseUp',
        'wait',
        'aiWaitFor',
        'keyDown',
        'wait',
        'keyUp',
        'aiWaitFor',
        'aiAct',
        'aiTap',
        'aiWaitFor',
        'aiTap',
        'aiWaitFor',
        'aiAct',
        'aiAct',
        'keyPress',
        'aiAct',
      ],
      'welkin-moon': [
        'aiAct',
        'aiAct',
        'aiWaitFor',
        'aiAct',
        'aiAct',
        'aiWaitFor',
        'aiAct',
        'wait',
        'aiAct',
        'wait',
        'aiWaitFor',
        'aiAssert',
        'aiAct',
        'wait',
        'aiAct',
        'aiAct',
        'aiWaitFor',
        'aiAct',
        'aiAct',
        'screenshot',
        'aiAct',
      ],
    })
  })

  it('retains the critical claim, exit, and safety instructions', async () => {
    const skills = await loadSkills([resolve('skills')])
    const byId = new Map(skills.map(skill => [skill.id, skill]))
    const prompts = (id: string) => byId.get(id)!.steps.map(step => step.prompt).join('\n')

    expect(prompts('battle-pass-claim')).toContain('一键领取')
    expect(prompts('battle-pass-claim')).toContain('已回到游戏主界面')
    expect(prompts('claim-achievements')).toContain('点击所有「领取」按钮')
    expect(prompts('claim-achievements')).toContain('回到游戏主界面')
    expect(prompts('claim-event-rewards')).toContain('不要点击「前往任务」「前往挑战」「购买」')
    expect(prompts('claim-event-rewards')).toContain('回到游戏主界面')
    expect(prompts('claim-mail')).toContain('全部领取')
    expect(prompts('claim-mail')).toContain('回到游戏主界面')
    expect(prompts('welkin-moon')).toContain('开始游戏')
    expect(prompts('welkin-moon')).toContain('空月祝福')
  })

  it('rechecks every login gate after network recovery before entering the world', async () => {
    const skills = await loadSkills([resolve('skills')])
    const startup = skills.find(skill => skill.id === 'welkin-moon')!
    const recoveryIndex = startup.steps.findIndex(step =>
      step.method === 'aiAct'
      && step.prompt.startsWith('如果再次出现「网络错误」'))
    const gateWaitIndex = startup.steps.findIndex((step, index) =>
      index > recoveryIndex
      && step.method === 'aiWaitFor'
      && step.prompt.startsWith('网络恢复后'))
    const networkAssertIndex = startup.steps.findIndex((step, index) =>
      index > gateWaitIndex
      && step.method === 'aiAssert'
      && step.prompt.includes('明确判定本次启动失败'))
    const protocolIndex = startup.steps.findIndex((step, index) =>
      index > networkAssertIndex
      && step.method === 'aiAct'
      && step.prompt.includes('用户协议和隐私政策提示')
      && step.prompt.includes('接受'))
    const initialWait = startup.steps.find(step =>
      step.method === 'aiWaitFor'
      && step.prompt.includes('游戏开始加载'))
    const enterIndex = startup.steps.findIndex(step =>
      step.method === 'aiAct'
      && step.prompt.includes('登录大门底部明确显示「点击进入」'))

    expect(recoveryIndex).toBeGreaterThanOrEqual(0)
    expect(gateWaitIndex).toBeGreaterThan(recoveryIndex)
    expect(networkAssertIndex).toBe(gateWaitIndex + 1)
    expect(protocolIndex).toBe(networkAssertIndex + 1)
    expect(enterIndex).toBeGreaterThan(protocolIndex)
    expect(startup.steps[gateWaitIndex]?.prompt).toContain('网络错误')
    expect(startup.steps[gateWaitIndex]?.prompt).toContain('用户协议和隐私政策提示')
    expect(startup.steps[gateWaitIndex]?.prompt).toContain('点击进入')
    expect(startup.steps[gateWaitIndex]?.prompt).toContain('新手引导')
    expect(startup.steps[gateWaitIndex]?.prompt).toContain('加载和排队只是中间状态')
    expect(initialWait?.prompt).toContain('排队是正常中间状态')
    expect(initialWait?.prompt).not.toContain('排队则继续等待')
  })

  it('recovers the mail entry safely and gates claiming on mailbox confirmation', async () => {
    const skills = await loadSkills([resolve('skills')])
    const mail = skills.find(skill => skill.id === 'claim-mail')!
    const recoveryIndex = mail.steps.findIndex(step =>
      step.method === 'aiAct'
      && step.prompt.includes('误开云游戏平台面板'))
    const mailboxWaitIndex = mail.steps.findIndex((step, index) =>
      index > recoveryIndex
      && step.method === 'aiWaitFor'
      && step.prompt.includes('「邮箱」标题'))
    const mailboxAssertIndex = mail.steps.findIndex((step, index) =>
      index > mailboxWaitIndex
      && step.method === 'aiAssert'
      && step.prompt.includes('否则停止且不要领取'))
    const claimIndex = mail.steps.findIndex((step, index) =>
      index > mailboxAssertIndex
      && step.method === 'aiAct'
      && step.prompt.includes('「全部领取」'))
    const entry = mail.steps.find(step =>
      step.method === 'aiTap'
      && step.prompt.includes('游戏内信封图标'))
    const recovery = mail.steps[recoveryIndex]

    expect(entry?.prompt).toContain('屏幕最左侧贴边的云游戏平台侧栏')
    expect(entry?.prompt).toContain('一律不要点击')
    expect(entry?.prompt).toContain('不使用固定坐标')
    expect(recoveryIndex).toBeGreaterThanOrEqual(0)
    expect(recovery?.prompt).toContain('名片选择界面')
    expect(recovery?.prompt).toContain('拍照模式')
    expect(recovery?.prompt).toContain('确认回到派蒙菜单')
    expect(recovery?.prompt).toContain('重新识别并点击')
    expect(mailboxWaitIndex).toBe(recoveryIndex + 1)
    expect(mailboxAssertIndex).toBe(mailboxWaitIndex + 1)
    expect(claimIndex).toBe(mailboxAssertIndex + 1)
  })

  it('expands the default and named routines to the intended execution order', async () => {
    const config = appConfigSchema.parse({ tasks: { skillsDirs: [resolve('skills')] } })
    const registry = new SkillRegistry()
    await registry.loadFromDirs(config.tasks.skillsDirs)
    const runner = new TaskRunner()
    runner.registerAll(registry.toTaskDefinitions())

    const ids = (selected: string[]) => runner.getEnabledTasks(selected).map(task => task.id)
    expect(ids(config.tasks.enabled)).toEqual([
      'welkin-moon',
      'claim-mail',
      'claim-achievements',
      'claim-event-rewards',
      'battle-pass-claim',
    ])
    expect(ids(config.tasks.routines.daily!)).toEqual(['welkin-moon', 'claim-mail'])
    expect(ids(config.tasks.routines.rewards!)).toEqual(ids(config.tasks.enabled))
    expect(ids(config.tasks.routines.full!)).toEqual(ids(config.tasks.enabled))
    expect(ids(config.tasks.routines.full!)).not.toContain('expedition-collect')
    expect(ids(config.tasks.routines.rewards!)).not.toContain('expedition-collect')
  })

  it('keeps high-risk event actions explicitly prohibited', async () => {
    const skills = await loadSkills([resolve('skills')])
    const event = skills.find(skill => skill.id === 'claim-event-rewards')
    expect(event?.goal).toContain('不购买')
    expect(event?.goal).toContain('不消耗原石')
    expect(event?.goal).toContain('不进入活动挑战')
  })
})
