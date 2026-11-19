import Phaser from 'phaser';
import BootScene from './scenes/BootScene.js';
import MapScene from './scenes/MapScene.js';
import TownScene from './scenes/TownScene.js';
import BattleScene from './scenes/BattleScene.js';
import DemoScene from './scenes/DemoScene.js';

// Phaser 游戏入口配置
// 设计原则：Phaser 只负责渲染与输入，所有游戏规则在 src/logic（纯 JS）中实现
const config = {
  type: Phaser.AUTO,
  parent: 'game',
  width: 1280,
  height: 800,
  backgroundColor: '#1a1a2e',
  scene: [BootScene, MapScene, TownScene, BattleScene, DemoScene],
  // 像素占位风格，关闭抗锯齿让色块边界清晰
  pixelArt: false,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  }
};

const game = new Phaser.Game(config);

// 暴露到 window，方便无头浏览器脚本（scripts/verify-*.cjs）驱动场景做自动化验证
window.__game = game;
