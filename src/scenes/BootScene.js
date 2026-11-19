import Phaser from 'phaser';
import { loadAllData } from '../core/DataLoader.js';
import { createNewGame } from '../core/GameState.js';
import { buildInitialForces } from '../logic/setup.js';
import { loadGame } from '../logic/saveLogic.js';
import { loadPixelArt } from '../core/pixelArt.js';

/**
 * BootScene —— 启动场景
 * 职责：加载数据表 → 创建初始游戏状态 → 进入大地图场景
 * 状态通过 this.registry 共享（key: 'state'），所有场景可读写
 *
 * M12：支持 URL 深链读档 —— 访问 ?slot=0 / ?slot=1 / ?slot=2 / ?slot=auto
 *      时，若该存档位有有效存档就直接载入那一局；否则照常开新局。
 *      （浏览器刷新后想回到存档局面，用这个参数最省事）
 *
 * M14：preload 里加载像素美术资源（public/assets/pixel/*.png）。
 *      资源缺失不会中断流程 —— 各场景会退回色块占位。
 */
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  /** 预加载：像素美术纹理（Phaser 会等 preload 结束才进 create） */
  preload() {
    loadPixelArt(this);
  }

  async create() {
    // 1. 加载全部数据表
    const data = await loadAllData();

    // 2. 状态与数据存入 registry，全局共享
    this.registry.set('state', this.createFreshState(data));
    this.registry.set('data', data);

    // 调试钩子：便于无头浏览器自动化测试读取状态
    if (typeof window !== 'undefined') {
      window.__gameState = this.registry.get('state');
      window.__gameData = data;
    }

    // 3. M13：?demo=1 直接进组件演示场景（不读档、不建局）
    if (this.isDemoUrl()) {
      this.scene.start('DemoScene');
      return;
    }

    // 4. M12：优先尝试读档（URL 带 slot 参数时），失败则开新局
    const loaded = this.loadFromUrl();
    if (loaded) {
      this.registry.set('state', loaded);
      if (typeof window !== 'undefined') window.__gameState = loaded;
    }

    // 5. 进入大地图
    this.scene.start('MapScene');
  }

  /**
   * URL 是否带了 ?demo=1（组件库演示）
   * @returns {boolean}
   */
  isDemoUrl() {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('demo') === '1';
  }

  /**
   * 按 URL 上的 ?slot= 参数读档
   * @returns {object|null} 读到的 state；没有参数或读档失败返回 null
   */
  loadFromUrl() {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const slot = params.get('slot');
    if (slot === null) return null;

    const r = loadGame(slot);
    if (!r.ok) {
      console.warn(`[M12] 读取存档位 ${slot} 失败：`, r.reason);
      return null;
    }
    console.log(`[M12] 已从存档位 ${slot} 载入：`, r.label);
    return r.state;
  }

  /**
   * 开一局新游戏
   * @param {object} data 数据表集合
   * @returns {object} 初始 GameState
   */
  createFreshState(data) {
    const state = createNewGame(data.mapDefault);
    buildInitialForces(state, data);
    return state;
  }
}
