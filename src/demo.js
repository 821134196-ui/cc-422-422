'use strict';
// 单条本地启动命令：npm run demo
// 重建 SQLite 演示数据，启动 Web 服务，并演出前后周转样例各跑一步。
const { createApp } = require('./server');

const PORT = Number(process.env.PORT || 8080);
const app = createApp({ reseed: true, startScheduler: true });

app.listen(PORT, () => {
  console.log('');
  console.log('  ──────────────────────────────────────────────────────────');
  console.log('  演艺场馆无线麦克风电池周转与充电系统（演示模式）');
  console.log(`  界面  http://localhost:${PORT}`);
  console.log('  ──────────────────────────────────────────────────────────');
  console.log('  演示样例：');
  console.log('  · 今晚 19:30《夜莺与玫瑰》两张领用单已锁定，一张草稿待锁定');
  console.log('  · 正在演出《声临阿莱城》电池持续放电，低电量自动入故障队列');
  console.log('  · 昨晚《仲夏夜合唱节》已清点：腰包丢失例外 + 迟到回传挂起');
  console.log('  · 充电柜：A3 接触不良 / A5 充电失败 / BT-11、BT-12 健康隔离待复核');
  console.log('  · 岗位：周砚秋(经理) 韩听澜(舞台主管) 沈既明(调音师) 陆知遥(设备员)');
  console.log('  ──────────────────────────────────────────────────────────');
  console.log('  提示：页面右上角可切换岗位，每 6 秒自动推进充电/放电。');
  console.log('');
});

// 启动后立即推进一轮，让接口立刻有动态数据
setTimeout(() => app.scheduler.tick(), 300);
