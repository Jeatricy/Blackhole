# GARGANTUA

实时 Schwarzschild 零测地线光线追踪器。每个像素积分一条真实的零测地线：阴影是测地线终结于视界的区域，光子环是测地线在 r = 3M 附近多次缠绕的区域，吸积盘的多重像是同一条测地线连续穿越赤道面的结果。

没有黑球贴图，没有 billboard 光环，没有视频，没有预渲染纹理。图像完全由片元着色器生成。

```
./run.sh                  # 起服务 + 自动开浏览器
./run.sh -h               # 全部选项
```

`run.sh` 会等端口真的能握手才开浏览器，端口被占用自动往后找 20 个，Ctrl+C
连服务器一起收掉。只想要服务器的话 `python3 serve.py` 也还在。

需要静态服务器：ES modules 和 `.glsl` 的 `fetch()` 在 `file://` 下都会被浏览器阻止。

## 物理

几何化单位，M = 1：

| 量 | 值 |
|---|---|
| 视界 r_s | 2M |
| 光子球 r_ph | 3M |
| ISCO | 6M |
| 临界碰撞参数 b_c | 3√3 M ≈ 5.196 |

积分 u = 1/r 的轨道方程

```
d²u/dφ² + u = 3M u²
```

在每条光线自身的轨道平面内用 RK4 推进。在平面内（而不是 3D 笛卡尔坐标）积分是这件事能实时的原因：状态只有两个 float，φ 单调递增所以多次盘面穿越自然产生，且赤道面穿越点可以解析定位而不需要求根。

穿越点位于 φ₀ + π/2 + kπ —— 因为盘面高度 y(φ) = A·cos(φ − φ₀)/u，其零点与 u 无关。步长自适应，限制每步 u 的相对变化，使近径向光线几步就飞出去，而近临界光线保持足够分辨率。

实现的相对论效应：

- **引力透镜与多重像**：一阶（直接）、二阶（盘的背面绕过视界）、更高阶由 `IMAGE ORDER` 控制
- **相对论集束**：g = √(1−3M/r) / (1 − Ω·ℓ)，强度按 g⁴ 缩放。符号约定见 `blackhole.frag` 中 `shiftFactor` 的注释——它决定哪一侧被增亮，是最容易搞错的地方
- **引力红移 + 多普勒色移**：观测温度 T·g^k，经普朗克轨迹转换为色度
- **观察者光行差**：`OBSERVER β` 在积分*之前*修正光线方向（这才是物理的：它改变像素看向哪条测地线，而不只是改变亮度）
- **Novikov-Thorne 温度剖面**：T ∝ r^(−3/4)(1−√(r_in/r))^(1/4)，峰值锁定在 49/36 r_in
- **开普勒剪切**：湍流场随局部角速度共转，结构自动缠成尾随螺旋

## 验证

`tests/run_tests.py` 用 DevTools Protocol 驱动 Chrome，检查的是**图像**而不只是"没有抛异常"。最关键的一项：调试视图 7 把捕获截面渲染为精确的黑色掩模，并叠加由闭式解 b_c = 3√3M 独立绘制的橙色环。两者必须重合。

在 SwiftShader（无 GPU）下实测：

```
解析临界曲线 b_c 与投影自洽    59.5px vs 59.9px   (0.7%)
积分捕获边界符合解析解         57.3px vs 59.9px   (4.4%)
阴影为正圆                    min/max = 0.966
阴影居中于视轴                offset = (-0.5, -0.5) px
Doppler 不对称                +0.329，反转自旋后 -0.351，关闭后 -0.013
```

积分边界落在 b_c 内侧约 3%：b 略小于 b_c 的光线需要无界多次缠绕才能到达视界，少数用尽步数预算的会被渲染成天空。这个偏差随步数只以对数速度收敛（192 → 512 步几乎不变），方向是保守的。

```
python3 tests/run_tests.py                  # 完整验收
python3 tests/probe.py 8099 "" out.png      # 单帧定量诊断
```

## 控制

21 个参数分为 5 组（相对论 / 吸积盘 / 天空 / 相机与渲染 / 后处理），全部由 `src/core/params.js` 的 `PARAMS` 表驱动 —— HUD 滑块、帮助文本、uniform 上传、URL 编解码都从它生成，所以 UI 不可能与着色器的真实输入脱节。在参数标签上上下拖动可微调。

三档质量（STD 192 步 / HIGH 320 / CINE 512）。`MAX_STEPS` 是编译期常量，切档会重编译一次着色器；帧率不足时自适应降低步数预算（画质先在阴影边缘退化，那里动态中最不显眼）。

按 `?` 查看全部快捷键。0–9 切换调试视图：

| | |
|---|---|
| 0 | 最终合成 |
| 1 | Beauty（无泛光） |
| 2 | 仅泛光 |
| 3 | 亮度 / 曝光假色 |
| 4 | 积分开销（每像素步数） |
| 5 | 盘面穿越次数 n |
| 6 | 红移 g 假色 |
| 7 | 碰撞参数 b + 解析临界曲线 |
| 8 | 透镜化天空 + 经纬网格 |
| 9 | 盘面径向网格（r_ph / ISCO 标记） |

视图 4–9 绕过 ACES：滤镜曲线会把 0.003 以下的线性值压成纯黑，会把定量读数变成一团糊。

## 自动化

`window.GARGANTUA` 是稳定接口，`window.__gargantuaReady` 在启动完成时 resolve。

```js
await window.__gargantuaReady;
GARGANTUA.setPreset(1, true);                          // true = 跳过运镜补间
GARGANTUA.setParams({ temp: 12000, doppler: 1.2 });
const png = GARGANTUA.renderFrame({ width: 3840, height: 2160, time: 12.5 });
GARGANTUA.state();                                     // 尺寸、帧数、fps、错误
```

URL 参数：`?quality=cinematic&preset=edge-on&view=7&t=8&w=1920&h=1080&hud=0&paused=1&p.temp=14000`

状态编码进 URL hash 并持久化到 localStorage。优先级：默认值 < localStorage < hash < query。

**读回画布必须与渲染在同一个 task 内**：`preserveDrawingBuffer` 为 false 时，合成之后绘制缓冲就被清空了。`renderFrame()` 内部保证了这个顺序；直接读 `canvas` 之前请先调用 `app.renderOnce()`。

## 结构

```
index.html              import map + HUD DOM
run.sh                  一键启动（选端口、等就绪、开浏览器、退出时收尾）
serve.py                静态服务器（正确的 .glsl MIME + 不缓存）
src/
  main.js               启动、帧循环、输入、自适应质量、上下文丢失恢复
  styles.css
  core/
    params.js           21 个参数的唯一来源、质量档、持久化
    shaders.js          .glsl 加载 + 递归 #include 解析
    renderer.js         WebGL2 管线：测地线 → HDR → 泛光 mip 链 → 合成
    camera.js           观察者参考系、4 个预设、电影镜头循环
    hud.js              读数、生成式参数面板、帮助
    audio.js            程序化 WebAudio（音高随观察者时间膨胀下移）
    capture.js          截图 + 自动化接口
  shaders/
    blackhole.frag      测地线积分器（核心）
    sky.glsl            程序化星场 + 银河
    common.glsl         噪声、哈希、工具
    color.glsl          黑体色度、ACES、sRGB
    bloom.frag          预滤波 / 降采样 / 升采样
    composite.frag      曝光 → 色散 → ACES → 暗角 → 颗粒 → sRGB
    fullscreen.vert
tools/make_audio.py     生成无缝循环氛围音频
tests/                  验收测试 + 定量诊断探针
vendor/three/           three.js r185（MIT），完全离线
```

three.js 只作为薄 GL/RT 封装使用：没有场景图、没有灯光、除一个全屏三角形外没有网格。

## 音频

氛围音床默认完全由 WebAudio 程序化合成，无需任何二进制资源。若 `assets/audio/gargantua-drone.wav` 存在则叠加为预渲染 pad。音高随观察者的引力时间膨胀下移 —— 俯冲向视界时听得出来。

```
python3 tools/make_audio.py     # 重新生成（纯标准库，无 numpy）
```

循环是**构造上**无缝的，不是靠交叉淡化：所有分音及其 LFO 都落在缓冲基频 f₀ = sr/N 的整数倍上，噪声床在频域合成后逆 FFT，因此天然循环。实测环绕点的采样步进（163）小于缓冲内部的平均步进（209）。

## 已知限制

- 需要 WebGL2（GLSL ES 3.00）。缺少 `EXT_color_buffer_float` 时降级到 8-bit 并限制泛光，不会失败
- 度规是 Schwarzschild（无自旋）。`SPIN SENSE` 是**盘的**转向，不是 Kerr 参数 a
- 盘为光学薄发射 + 吸收模型，未做辐射转移的散射项
- 观察者在 r < 3.15M 以内被约束（光子球内侧不存在静态观察者参考系）
- WCAG：已做键盘可达、`aria-*`、`prefers-reduced-motion`、焦点可见。完整合规仍需辅助技术实测与专家评审

## 许可

`vendor/three/` 为 three.js r185，MIT，见 `vendor/three/LICENSE`。
