/**
 * 全局事件总线（单例）
 * 逻辑层与渲染层之间只通过事件通信，互不直接引用。
 *
 * 约定事件名（持续补充）：
 *   'turn:start'        { playerId }          回合开始
 *   'turn:end'          { playerId }          回合结束
 *   'day:new'           { day, week }         新的一天（资源结算后触发）
 *   'hero:moved'        { heroId, from, to }  英雄移动完成
 *   'hero:enterTown'    { heroId, townId }    英雄进入城镇
 *   'battle:start'      { attacker, defender, battlefield } 战斗开始
 *   'battle:end'        { winnerId, loserId } 战斗结束
 *   'battle:resolved'   { winner, exp, levelUps, removedHeroes, capturedTownId, ... } 战果结算（M6c）
 *   'battle:action'     { attackerId, defenderId, damage, killed, retaliate } 一次攻击（M6b，M7 用它播前冲/抖动/飘字）
 *   'battle:move'       { stackId, from, to }  一次移动（M6b，M7 用它播平移动画）
 *   'battle:turn'       { stackId, round }    出手推进（M6a）
 *   'battle:round'      { round }             进入新一轮（M6a）
 *   'hero:exp'          { heroId, gained, level, levelUps } 经验结算（M6c）
 *   'hero:levelup'      { heroId, skillId, level, pendingLevels } 技能加点（M8）
 *   'hero:hired'        { heroId, townId, name } 城镇招募新武将（M6c）
 *   'hero:mana'         { heroId, mana, maxMana, gained } 法力变动（M9）
 *   'hero:spellLearned' { heroId, spellIds }     学会新魔法（M9）
 *   'magic:cast'        { heroId, spellId, targetStackId, effectDesc } 施放魔法（M9，M7 用它播施法光环）
 *   'resource:changed'  { playerId, resources } 资源变动
 *   'ui:toast'          { text }              界面提示
 */
class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * 订阅事件
   * @param {string} event 事件名
   * @param {Function} fn 回调
   * @returns {() => void} 取消订阅函数
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  /** 取消订阅 */
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  /**
   * 触发事件（同步派发）
   * @param {string} event 事件名
   * @param {object} [payload] 事件数据
   */
  emit(event, payload = {}) {
    this._listeners.get(event)?.forEach((fn) => fn(payload));
  }

  /** 清空所有订阅（测试用） */
  clear() {
    this._listeners.clear();
  }
}

// 全局单例，逻辑层与渲染层共用
export const bus = new EventBus();
export default bus;
