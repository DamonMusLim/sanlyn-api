var DSU = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // node_modules/drawstamputils/src/DrawStampUtils.ts
  var DrawStampUtils_exports = {};
  __export(DrawStampUtils_exports, {
    DrawStampUtils: () => DrawStampUtils
  });
  var RULER_WIDTH = 80;
  var RULER_HEIGHT = 80;
  var DrawStampUtils = class {
    // 缩放参数
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    // 主色
    primaryColor = "#ff0000";
    // 毫米到像素的
    mmToPixel;
    // 主canvas的context
    canvasCtx;
    // 离屏的canvas
    offscreenCanvas;
    // 主canvas
    canvas;
    stampOffsetX = 0;
    stampOffsetY = 0;
    agingIntensity = 50;
    ruler = {
      showRuler: true,
      showFullRuler: true
    };
    drawStar = {
      svgPath: "M 0 -1 L 0.588 0.809 L -0.951 -0.309 L 0.951 -0.309 L -0.588 0.809 Z",
      drawStar: false,
      starDiameter: 14,
      starPositionY: 0,
      scaleToSmallStar: false,
      useImage: false,
      imageUrl: "",
      imageWidth: 10,
      imageHeight: 10,
      keepAspectRatio: true
    };
    // 防伪纹路
    securityPattern = {
      openSecurityPattern: true,
      securityPatternWidth: 0.15,
      securityPatternLength: 3,
      securityPatternCount: 5,
      securityPatternAngleRange: 40,
      securityPatternParams: []
    };
    company = {
      companyName: "\u5370\u7AE0\u7ED8\u5236\u6709\u9650\u8D23\u4EFB\u516C\u53F8",
      compression: 1,
      borderOffset: 1,
      textDistributionFactor: 5,
      fontFamily: "SimSun",
      fontHeight: 4.2,
      fontWeight: "normal",
      shape: "ellipse",
      adjustEllipseText: false,
      adjustEllipseTextFactor: 0.5
    };
    taxNumber = {
      code: "000000000000000000",
      compression: 0.7,
      fontHeight: 3.7,
      fontFamily: "Arial",
      fontWidth: 1.3,
      letterSpacing: 8,
      positionY: 0,
      totalWidth: 26,
      fontWeight: "normal"
    };
    stampCode = {
      code: "1234567890",
      compression: 1,
      fontHeight: 1.2,
      fontFamily: "Arial",
      borderOffset: 1,
      fontWidth: 1.2,
      textDistributionFactor: 50,
      fontWeight: "normal"
    };
    stampType = {
      stampType: "\u53D1\u7968\u4E13\u7528\u7AE0",
      fontHeight: 4.6,
      fontFamily: "Arial",
      fontWidth: 3,
      compression: 0.75,
      letterSpacing: 0,
      positionY: -3,
      fontWeight: "normal",
      lineSpacing: 2
      // 新增：行间距
    };
    // 做旧效果
    agingEffect = {
      applyAging: false,
      agingIntensity: 50,
      agingEffectParams: []
    };
    // 内圈圆
    innerCircle = {
      drawInnerCircle: true,
      innerCircleLineWidth: 0.5,
      innerCircleLineRadiusX: 16,
      innerCircleLineRadiusY: 12
    };
    // 比外圈细的稍微内
    outThinCircle = {
      drawInnerCircle: true,
      innerCircleLineWidth: 0.2,
      innerCircleLineRadiusX: 36,
      innerCircleLineRadiusY: 27
    };
    // 毛边效果
    roughEdge = {
      drawRoughEdge: true,
      roughEdgeWidth: 0.2,
      roughEdgeHeight: 5,
      roughEdgeParams: [],
      roughEdgeProbability: 0.3,
      roughEdgeShift: 8,
      roughEdgePoints: 360
    };
    // 印章类型列表，用于多行的文字显示，且可以设置每行的高度和文字宽度，默认添加一个发票专用章类型
    stampTypeList = [
      {
        stampType: "\u53D1\u7968\u4E13\u7528\u7AE0",
        fontHeight: 4.6,
        fontFamily: "Arial",
        fontWidth: 3,
        compression: 0.75,
        letterSpacing: 0,
        positionY: -3,
        fontWeight: "normal",
        lineSpacing: 2
        // 新增：行间距
      }
    ];
    // 添加公司列表属性
    companyList = [
      {
        companyName: "\u7ED8\u5236\u5370\u7AE0\u6709\u9650\u8D23\u4EFB\u516C\u53F8",
        compression: 1,
        borderOffset: 1,
        textDistributionFactor: 3,
        // 将默认值从20改为10
        fontFamily: "SimSun",
        fontHeight: 4.2,
        fontWeight: "normal",
        shape: "ellipse",
        adjustEllipseText: true,
        adjustEllipseTextFactor: 0.5
      }
    ];
    innerCircleList = [];
    // 总的印章绘制参数
    drawStampConfigs = {
      roughEdge: this.roughEdge,
      ruler: this.ruler,
      drawStar: this.drawStar,
      securityPattern: this.securityPattern,
      company: this.company,
      stampCode: this.stampCode,
      width: 40,
      height: 30,
      stampType: this.stampType,
      primaryColor: this.primaryColor,
      borderWidth: 1,
      refreshSecurityPattern: false,
      refreshOld: false,
      taxNumber: this.taxNumber,
      agingEffect: this.agingEffect,
      shouldDrawRuler: true,
      innerCircle: this.innerCircle,
      outThinCircle: this.outThinCircle,
      openManualAging: false,
      stampTypeList: this.stampTypeList,
      companyList: this.companyList,
      innerCircleList: this.innerCircleList
    };
    // 添加图片缓存
    imageCache = /* @__PURE__ */ new Map();
    /**
     * 构造函数
     * @param canvas 画布
     * @param mmToPixel 毫米到像素的转换比例
     */
    constructor(canvas, mmToPixel) {
      if (!canvas) {
        throw new Error("Canvas is null");
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Failed to get canvas context");
      }
      this.canvasCtx = ctx;
      this.mmToPixel = mmToPixel;
      this.canvas = canvas;
      this.offscreenCanvas = document.createElement("canvas");
      if (this.canvas && this.offscreenCanvas) {
        this.offscreenCanvas.width = canvas.width;
        this.offscreenCanvas.height = canvas.height;
      }
      this.addCanvasListener();
    }
    isDragging = false;
    dragStartX = 0;
    dragStartY = 0;
    // 获取绘制印章的配置
    getDrawConfigs() {
      return this.drawStampConfigs;
    }
    /**
     * 手动做旧效果
     * @param x
     * @param y
     * @param intensity
     */
    addManualAgingEffect(x, y, intensityFactor) {
      console.log("\u624B\u52A8\u505A\u65E7   1", x, y, this.drawStampConfigs.agingEffect.agingEffectParams);
      const radius = 1 * this.mmToPixel;
      const adjustedX = x - this.stampOffsetX * this.mmToPixel;
      const adjustedY = y - this.stampOffsetY * this.mmToPixel;
      for (let i = 0; i < 10; i++) {
        this.drawStampConfigs.agingEffect.agingEffectParams.push({
          x: adjustedX,
          y: adjustedY,
          noiseSize: Math.random() * 3 + 1,
          noise: Math.random() * 200 * intensityFactor,
          strongNoiseSize: Math.random() * 5 + 2,
          strongNoise: Math.random() * 250 * intensityFactor + 5,
          fade: Math.random() * 50 * intensityFactor,
          seed: Math.random()
        });
      }
      this.refreshStamp(false, false);
      this.canvasCtx.save();
      this.canvasCtx.globalCompositeOperation = "destination-out";
      this.canvasCtx.beginPath();
      this.canvasCtx.arc(x, y, radius, 0, Math.PI * 2, true);
      this.canvasCtx.fillStyle = "rgba(255, 255, 255, 0.5)";
      this.canvasCtx.fill();
      this.canvasCtx.restore();
    }
    // 设置绘制印章的配置，比如可以保存某些印章的配置，然后保存之后直接设置绘制，更加方便
    setDrawConfigs(drawConfigs) {
      this.drawStampConfigs = drawConfigs;
    }
    addCanvasListener() {
      this.canvas.addEventListener("mousemove", (event) => {
        if (this.drawStampConfigs.openManualAging && event.buttons === 1) {
          const rect = this.canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const agingIntensity = this.drawStampConfigs.agingEffect.agingIntensity / 100;
          this.addManualAgingEffect(x, y, agingIntensity);
        } else {
          this.onMouseMove(event);
        }
      });
      this.canvas.addEventListener("mouseleave", (event) => {
        this.onMouseLeave(event);
      });
      this.canvas.addEventListener("mousedown", (event) => {
        this.onMouseDown(event);
        if (this.drawStampConfigs.openManualAging) {
          const rect = this.canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const agingIntensity = this.drawStampConfigs.agingEffect.agingIntensity / 100;
          this.addManualAgingEffect(x, y, agingIntensity);
        }
      });
      this.canvas.addEventListener("mouseup", (event) => {
        this.onMouseUp();
      });
      this.canvas.addEventListener("click", (event) => {
        this.onCanvasClick(event);
      });
      this.canvas.addEventListener("wheel", (event) => {
        if (event.ctrlKey) {
          event.preventDefault();
          const zoom = event.deltaY > 0 ? 0.9 : 1.1;
          this.zoomCanvas(event.offsetX, event.offsetY, zoom);
        }
      });
    }
    zoomCanvas(mouseX, mouseY, zoom) {
      const oldScale = this.scale;
      this.scale *= zoom;
      this.scale = Math.max(0.1, Math.min(5, this.scale));
      this.offsetX = mouseX - (mouseX - this.offsetX) * (this.scale / oldScale);
      this.offsetY = mouseY - (mouseY - this.offsetY) * (this.scale / oldScale);
      this.refreshStamp();
    }
    onMouseUp = () => {
      this.isDragging = false;
      this.refreshStamp(false, false);
    };
    // 点击印章区域，比如五角星等位置然后进行相应的跳转之类的
    onCanvasClick = (event) => {
      const canvas = this.canvas;
      if (!canvas) return;
    };
    onMouseLeave = (event) => {
      this.isDragging = false;
      this.refreshStamp();
    };
    onMouseDown = (event) => {
      this.isDragging = true;
      this.dragStartX = event.clientX - this.stampOffsetX * this.mmToPixel;
      this.dragStartY = event.clientY - this.stampOffsetY * this.mmToPixel;
    };
    onMouseMove = (event) => {
      if (this.drawStampConfigs.openManualAging) {
        return;
      }
      if (this.isDragging) {
        const newOffsetX = (event.clientX - this.dragStartX) / this.mmToPixel;
        const newOffsetY = (event.clientY - this.dragStartY) / this.mmToPixel;
        this.stampOffsetX = Math.round(newOffsetX * 10) / 10;
        this.stampOffsetY = Math.round(newOffsetY * 10) / 10;
        this.refreshStamp();
      } else {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const mmX = Math.round((x - RULER_WIDTH) / this.mmToPixel * 10) / 10;
        const mmY = Math.round((y - RULER_HEIGHT) / this.mmToPixel * 10) / 10;
        this.refreshStamp();
        this.highlightRulerPosition(this.canvasCtx, mmX, mmY);
        this.drawCrossLines(x, y);
      }
    };
    highlightRulerPosition = (ctx, mmX, mmY) => {
      const x = mmX * this.mmToPixel + RULER_WIDTH;
      const y = mmY * this.mmToPixel + RULER_HEIGHT;
      ctx.fillStyle = this.drawStampConfigs.primaryColor;
      ctx.fillRect(RULER_WIDTH, y - 1, this.canvas.width - RULER_WIDTH, 2);
      ctx.fillRect(x - 1, RULER_HEIGHT, 2, this.canvas.height - RULER_HEIGHT);
      ctx.fillStyle = "black";
      ctx.font = "bold 12px Arial";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const showPositionX = mmX / this.scale;
      const showPositionY = mmY / this.scale;
      ctx.fillText(`${showPositionX.toFixed(1)}mm, ${showPositionY.toFixed(1)}mm, scale: ${this.scale.toFixed(2)}`, RULER_WIDTH + 5, RULER_HEIGHT + 5);
    };
    drawCrossLines = (x, y) => {
      const canvas = this.offscreenCanvas;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255, 0, 0, 0.5)";
      ctx.lineWidth = 1;
      ctx.moveTo(RULER_WIDTH, y);
      ctx.lineTo(canvas.width, y);
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
      const mainCanvas = this.canvas;
      if (mainCanvas) {
        const mainCtx = mainCanvas.getContext("2d");
        if (mainCtx) {
          mainCtx.drawImage(canvas, 0, 0);
        }
      }
    };
    cropAndDownloadEllipse(img, ellipse) {
      const width = ellipse.size.height > ellipse.size.width ? ellipse.size.height : ellipse.size.width;
      const height = ellipse.size.height < ellipse.size.width ? ellipse.size.height : ellipse.size.width;
      const centerX = ellipse.center.x;
      const centerY = ellipse.center.y;
      const scaleFactor = 1.2;
      const scaledWidth = width * scaleFactor;
      const scaledHeight = height * scaleFactor;
      let cropCanvas = document.createElement("canvas");
      cropCanvas.width = scaledWidth;
      cropCanvas.height = scaledHeight;
      let ctx = cropCanvas.getContext("2d");
      if (ctx) {
        ctx.beginPath();
        ctx.ellipse(scaledWidth / 2, scaledHeight / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        let sx = centerX - scaledWidth / 2;
        let sy = centerY - scaledHeight / 2;
        let sWidth = scaledWidth;
        let sHeight = scaledHeight;
        if (sx < 0) {
          sWidth += sx;
          sx = 0;
        }
        if (sy < 0) {
          sHeight += sy;
          sy = 0;
        }
        if (sx + sWidth > img.width) {
          sWidth = img.width - sx;
        }
        if (sy + sHeight > img.height) {
          sHeight = img.height - sy;
        }
        ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, scaledWidth, scaledHeight);
        let dataURL = cropCanvas.toDataURL("image/png");
        return dataURL;
      }
    }
    cropAndDownloadCircle(img, circle) {
      const scaleFactor = 1.2;
      let newRadius = circle.radius * scaleFactor;
      let size = newRadius * 2;
      let cropCanvas = document.createElement("canvas");
      cropCanvas.width = size;
      cropCanvas.height = size;
      let ctx = cropCanvas.getContext("2d");
      if (ctx) {
        ctx.beginPath();
        ctx.arc(newRadius, newRadius, newRadius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        let sx = circle.x - newRadius;
        let sy = circle.y - newRadius;
        let sWidth = size;
        let sHeight = size;
        if (sx < 0) {
          sWidth += sx;
          sx = 0;
        }
        if (sy < 0) {
          sHeight += sy;
          sy = 0;
        }
        if (sx + sWidth > img.width) {
          sWidth = img.width - sx;
        }
        if (sy + sHeight > img.height) {
          sHeight = img.height - sy;
        }
        ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, size, size);
        let dataURL = cropCanvas.toDataURL("image/png");
        return dataURL;
      }
    }
    /**
     * 解析SVG路径数据
     * @param svgPath SVG路径字符串
     * @returns 解析后的路径命令数组
     */
    parseSVGPath(svgPath) {
      const commands = [];
      const regex = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+)/g;
      let match;
      let currentCommand = "";
      let currentParams = [];
      while ((match = regex.exec(svgPath)) !== null) {
        if (match[1]) {
          if (currentCommand) {
            commands.push({ command: currentCommand, params: currentParams });
            currentParams = [];
          }
          currentCommand = match[1];
        } else if (match[2]) {
          currentParams.push(parseFloat(match[2]));
        }
      }
      if (currentCommand) {
        commands.push({ command: currentCommand, params: currentParams });
      }
      return commands;
    }
    scaleSVGPathTo10mm(svgPath) {
      const pathData = this.parseSVGPath(svgPath);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let currentX = 0, currentY = 0;
      pathData.forEach(({ command, params }) => {
        switch (command) {
          case "M":
          case "L":
          case "C":
          case "S":
          case "Q":
          case "T":
            for (let i = 0; i < params.length; i += 2) {
              minX = Math.min(minX, params[i]);
              maxX = Math.max(maxX, params[i]);
              minY = Math.min(minY, params[i + 1]);
              maxY = Math.max(maxY, params[i + 1]);
            }
            break;
          case "m":
          case "l":
          case "c":
          case "s":
          case "q":
          case "t":
            for (let i = 0; i < params.length; i += 2) {
              currentX += params[i];
              currentY += params[i + 1];
              minX = Math.min(minX, currentX);
              maxX = Math.max(maxX, currentX);
              minY = Math.min(minY, currentY);
              maxY = Math.max(maxY, currentY);
            }
            break;
          case "H":
            minX = Math.min(minX, params[0]);
            maxX = Math.max(maxX, params[0]);
            break;
          case "h":
            currentX += params[0];
            minX = Math.min(minX, currentX);
            maxX = Math.max(maxX, currentX);
            break;
          case "V":
            minY = Math.min(minY, params[0]);
            maxY = Math.max(maxY, params[0]);
            break;
          case "v":
            currentY += params[0];
            minY = Math.min(minY, currentY);
            maxY = Math.max(maxY, currentY);
            break;
        }
      });
      const width = maxX - minX;
      const height = maxY - minY;
      const scale = 5 / Math.max(width, height);
      const scaledPathData = pathData.map(({ command, params }) => {
        const scaledParams = params.map((param) => param * scale);
        return { command, params: scaledParams };
      });
      return this.convertPathDataToString(scaledPathData);
    }
    /**
     * 将解析后的路径数据转换为字符串
     * @param pathData 解析后的路径数据
     * @returns SVG路径字符串
     */
    convertPathDataToString(pathData) {
      return pathData.map(({ command, params }) => {
        return command + params.map((p) => p.toFixed(2)).join(" ");
      }).join(" ");
    }
    drawSVGPath(ctx, svgPath, x, y, scale = 1) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      const path = new Path2D(svgPath);
      ctx.fillStyle = this.primaryColor;
      ctx.fill(path);
      ctx.restore();
    }
    /**
     * 根据解析的SVG路径数据绘制图形
     * @param ctx 画布上下文
     * @param path 解析后的SVG路径数据
     * @param x 绘制的x坐标
     * @param y 绘制的y坐标
     * @param scale 缩放比例
     */
    drawSVGPath2(ctx, path, x, y, scale = 1) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.beginPath();
      let currentX = 0;
      let currentY = 0;
      let startX = 0;
      let startY = 0;
      let controlX = 0;
      let controlY = 0;
      path.forEach(({ command, params }) => {
        const paramCount = params.length;
        switch (command) {
          case "M":
          case "m":
            if (command === "M") {
              currentX = params[0];
              currentY = params[1];
            } else {
              currentX += params[0];
              currentY += params[1];
            }
            ctx.moveTo(currentX, currentY);
            startX = currentX;
            startY = currentY;
            break;
          case "L":
          case "l":
            for (let i = 0; i < paramCount; i += 2) {
              if (command === "L") {
                currentX = params[i];
                currentY = params[i + 1];
              } else {
                currentX += params[i];
                currentY += params[i + 1];
              }
              ctx.lineTo(currentX, currentY);
            }
            break;
          case "H":
          case "h":
            for (let i = 0; i < paramCount; i++) {
              if (command === "H") {
                currentX = params[i];
              } else {
                currentX += params[i];
              }
              ctx.lineTo(currentX, currentY);
            }
            break;
          case "V":
          case "v":
            for (let i = 0; i < paramCount; i++) {
              if (command === "V") {
                currentY = params[i];
              } else {
                currentY += params[i];
              }
              ctx.lineTo(currentX, currentY);
            }
            break;
          case "C":
          case "c":
            for (let i = 0; i < paramCount; i += 6) {
              const [cp1x, cp1y, cp2x, cp2y, x2, y2] = command === "C" ? params.slice(i, i + 6) : params.slice(i, i + 6).map((p, index) => index % 2 === 0 ? p + currentX : p + currentY);
              ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
              controlX = cp2x;
              controlY = cp2y;
              currentX = x2;
              currentY = y2;
            }
            break;
          case "S":
          case "s":
            for (let i = 0; i < paramCount; i += 4) {
              let [cp2x, cp2y, x2, y2] = command === "S" ? params.slice(i, i + 4) : params.slice(i, i + 4).map((p, index) => index % 2 === 0 ? p + currentX : p + currentY);
              const cp1x = currentX + (currentX - controlX);
              const cp1y = currentY + (currentY - controlY);
              ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
              controlX = cp2x;
              controlY = cp2y;
              currentX = x2;
              currentY = y2;
            }
            break;
          case "Q":
          case "q":
            for (let i = 0; i < paramCount; i += 4) {
              const [cpx, cpy, x2, y2] = command === "Q" ? params.slice(i, i + 4) : params.slice(i, i + 4).map((p, index) => index % 2 === 0 ? p + currentX : p + currentY);
              ctx.quadraticCurveTo(cpx, cpy, x2, y2);
              controlX = cpx;
              controlY = cpy;
              currentX = x2;
              currentY = y2;
            }
            break;
          case "T":
          case "t":
            for (let i = 0; i < paramCount; i += 2) {
              const [x2, y2] = command === "T" ? params.slice(i, i + 2) : [params[i] + currentX, params[i + 1] + currentY];
              const cpx = currentX + (currentX - controlX);
              const cpy = currentY + (currentY - controlY);
              ctx.quadraticCurveTo(cpx, cpy, x2, y2);
              controlX = cpx;
              controlY = cpy;
              currentX = x2;
              currentY = y2;
            }
            break;
          case "A":
          case "a":
            for (let i = 0; i < paramCount; i += 7) {
              const [rx, ry, xAxisRotation, largeArcFlag, sweepFlag, x2, y2] = command === "A" ? params.slice(i, i + 7) : [...params.slice(i, i + 5), params[i + 5] + currentX, params[i + 6] + currentY];
              ctx.ellipse(x2, y2, rx, ry, xAxisRotation, 0, 2 * Math.PI);
              currentX = x2;
              currentY = y2;
            }
            break;
          case "Z":
          case "z":
            ctx.closePath();
            currentX = startX;
            currentY = startY;
            break;
        }
      });
      ctx.fillStyle = this.primaryColor;
      ctx.fill();
      ctx.restore();
    }
    /**
     * 绘制SVG路径数据
     * @param ctx Canvas上下文
     * @param svgData SVG路径数据
     * @param x 绘制中心的x坐标
     * @param y 绘制中心的y坐标
     * @param size 绘制大小
     */
    drawSVGData(ctx, svgData, x, y, size) {
      ctx.save();
      ctx.translate(x, y);
      const path = new Path2D(svgData);
      const svgViewBox = [0, 0, 24, 24];
      const scale = size / Math.max(svgViewBox[2], svgViewBox[3]);
      ctx.scale(scale, scale);
      ctx.translate(-svgViewBox[2] / 2, -svgViewBox[3] / 2);
      ctx.fillStyle = this.primaryColor;
      ctx.fill(path);
      ctx.strokeStyle = this.primaryColor;
      ctx.lineWidth = 1.5 / scale;
      ctx.stroke(path);
      ctx.restore();
    }
    /**
     * 绘制五角星
     * @param canvasCtx 画笔
     * @param x 圆心x坐标
     * @param y 圆心y坐标
     * @param r 半径
     */
    async drawStarShape(ctx, starConfig, centerX, centerY) {
      if (starConfig.useImage && starConfig.imageUrl) {
        let img = this.imageCache.get(starConfig.imageUrl);
        if (img) {
          let width = starConfig.imageWidth * this.mmToPixel;
          let height = starConfig.imageHeight * this.mmToPixel;
          if (starConfig.keepAspectRatio) {
            const scale = Math.min(width / img.width, height / img.height);
            width = img.width * scale;
            height = img.height * scale;
          }
          const x = centerX - width / 2;
          const y = centerY + starConfig.starPositionY * this.mmToPixel - height / 2;
          ctx.save();
          ctx.drawImage(img, x, y, width, height);
          ctx.restore();
        } else {
          try {
            const tempImg = new Image();
            tempImg.src = starConfig.imageUrl;
            await new Promise((resolve, reject) => {
              tempImg.onload = resolve;
              tempImg.onerror = reject;
            });
            const bitmap = await createImageBitmap(tempImg);
            this.imageCache.set(starConfig.imageUrl, bitmap);
            let width = starConfig.imageWidth * this.mmToPixel;
            let height = starConfig.imageHeight * this.mmToPixel;
            if (starConfig.keepAspectRatio) {
              const scale = Math.min(width / bitmap.width, height / bitmap.height);
              width = bitmap.width * scale;
              height = bitmap.height * scale;
            }
            const x = centerX - width / 2;
            const y = centerY + starConfig.starPositionY * this.mmToPixel - height / 2;
            ctx.save();
            ctx.drawImage(bitmap, x, y, width, height);
            ctx.restore();
            requestAnimationFrame(() => {
              this.refreshStamp();
            });
          } catch (error) {
            console.error("Error loading or processing image:", error);
          }
        }
      } else {
        const drawStarDia = starConfig.starDiameter / 2 * this.mmToPixel;
        if (starConfig.svgPath.startsWith("<svg")) {
          this.drawSVGContent(ctx, starConfig.svgPath, centerX, centerY, 1);
        } else {
          this.drawSVGPath(ctx, starConfig.svgPath, centerX, centerY, drawStarDia);
        }
      }
    }
    drawSVGContent(ctx, svgContent, x, y, scale = 1) {
      const svgElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svgElement.innerHTML = svgContent;
      const svgContentEle = svgElement.firstChild;
      const svgWidth = parseFloat(svgContentEle.getAttribute("width") || "0");
      const svgHeight = parseFloat(svgContentEle.getAttribute("height") || "0");
      const img = new Image();
      const svgBlob = new Blob([svgContent], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);
      img.onload = () => {
        console.log("svg content img loaded", x, y, svgWidth, svgHeight, img);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        ctx.drawImage(img, -svgWidth / 2, -svgHeight / 2, svgWidth, svgHeight);
        ctx.restore();
        URL.revokeObjectURL(url);
      };
      img.src = url;
      img.onerror = (error) => {
        console.error("\u52A0\u8F7DSVG\u56FE\u50CF\u65F6\u51FA\u9519:", error);
      };
    }
    /**
     * 绘制印章类型文字
     * @param centerX 圆心x坐标
     * @param centerY 圆心y坐标
     * @param radius 半径
     * @param text 文字
     * @param fontSize 字体大小
     * @param letterSpacing 字符间距
     * @param positionY 文字位置
     * @param fillColor 填充颜色
     */
    drawStampType(ctx, stampType, centerX, centerY, radiusX) {
      const fontSize = stampType.fontHeight * this.mmToPixel;
      const letterSpacing = stampType.letterSpacing;
      const positionY = stampType.positionY;
      const fontWeight = stampType.fontWeight || "normal";
      const lineSpacing = stampType.lineSpacing * this.mmToPixel;
      ctx.save();
      ctx.font = `${fontWeight} ${fontSize}px ${stampType.fontFamily}`;
      ctx.fillStyle = this.primaryColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const lines = stampType.stampType.split("\n");
      const lineCount = lines.length;
      lines.forEach((line, lineIndex) => {
        const chars = line.split("");
        const charWidths = chars.map((char) => ctx.measureText(char).width);
        const totalWidth = charWidths.reduce((sum, width) => sum + width, 0) + (chars.length - 1) * letterSpacing * this.mmToPixel;
        const lineOffset = (lineIndex - (lineCount - 1) / 2) * (fontSize + lineSpacing);
        const textY = centerY + radiusX * 0.5 + positionY * this.mmToPixel + lineOffset;
        ctx.save();
        ctx.translate(centerX, textY);
        let currentX = -totalWidth / 2;
        ctx.scale(stampType.compression, 1);
        chars.forEach((char, index) => {
          ctx.fillText(char, currentX + charWidths[index] / 2, 0);
          currentX += charWidths[index] + letterSpacing * this.mmToPixel;
        });
        ctx.restore();
      });
      ctx.restore();
    }
    drawStampTypeList(ctx, stampTypeList, centerX, centerY, radiusX) {
      stampTypeList.forEach((stampType) => {
        this.drawStampType(ctx, stampType, centerX, centerY, radiusX);
      });
      ctx.restore();
    }
    /**
     * 绘制防伪纹路
     * @param centerX 圆心x坐标
     * @param centerY 圆心y坐标
     * @param radiusX 半径x
     * @param radiusY 半径y
     * @param securityPatternWidth 纹路宽度
     * @param securityPatternLength 纹路长度
     */
    drawSecurityPattern(ctx, centerX, centerY, radiusX, radiusY, forceRefresh) {
      if (!this.securityPattern.openSecurityPattern) return;
      ctx.save();
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = this.securityPattern.securityPatternWidth * this.mmToPixel;
      ctx.globalCompositeOperation = "destination-out";
      const angleRangeRad = this.securityPattern.securityPatternAngleRange * Math.PI / 180;
      if (forceRefresh || this.drawStampConfigs.securityPattern.securityPatternParams.length === 0) {
        this.drawStampConfigs.securityPattern.securityPatternParams = [];
        for (let i = 0; i < this.securityPattern.securityPatternCount; i++) {
          const angle = Math.random() * Math.PI * 2;
          const normalAngle = Math.atan2(radiusY * Math.cos(angle), radiusX * Math.sin(angle));
          const lineAngle = normalAngle + (Math.random() - 0.5) * angleRangeRad;
          this.drawStampConfigs.securityPattern.securityPatternParams.push({ angle, lineAngle });
        }
      }
      this.drawStampConfigs.securityPattern.securityPatternParams.forEach(({ angle, lineAngle }) => {
        const x = centerX + radiusX * Math.cos(angle);
        const y = centerY + radiusY * Math.sin(angle);
        const length = this.securityPattern.securityPatternLength * this.mmToPixel;
        const startX = x - length / 2 * Math.cos(lineAngle);
        const startY = y - length / 2 * Math.sin(lineAngle);
        const endX = x + length / 2 * Math.cos(lineAngle);
        const endY = y + length / 2 * Math.sin(lineAngle);
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      });
      ctx.restore();
    }
    /**
     * 绘制椭圆
     * @param x 圆心x坐标
     * @param y 圆心y坐标
     * @param radiusX 半径x
     * @param radiusY 半径y
     * @param borderWidth 边框宽度
     * @param borderColor 边框颜色
     */
    drawEllipse(ctx, x, y, radiusX, radiusY, borderWidth, borderColor) {
      ctx.beginPath();
      ctx.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderWidth;
      ctx.stroke();
    }
    /**
     * 绘制公司名称
     * @param centerX 圆心x坐标
     * @param centerY 圆心y坐标
     * @param radiusX 椭圆长轴半径
     * @param radiusY 椭圆短轴半径
     * @param text 公司名称文本
     * @param fontSize 字体大小
     */
    drawCompanyName(ctx, company, centerX, centerY, radiusX, radiusY) {
      const fontSize = company.fontHeight * this.mmToPixel;
      const fontWeight = company.fontWeight || "normal";
      ctx.save();
      ctx.font = `${fontWeight} ${fontSize}px ${company.fontFamily}`;
      ctx.fillStyle = this.primaryColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const characters = company.companyName.split("");
      const characterCount = characters.length;
      const borderOffset = company.borderOffset * this.mmToPixel;
      const totalAngle = Math.PI * (0.5 + characterCount / (company.textDistributionFactor * 4));
      const startAngle = Math.PI + (Math.PI - totalAngle) / 2;
      const anglePerChar = totalAngle / characterCount;
      const halfCharCount = (characterCount + 1) / 2;
      if (company.adjustEllipseText) {
        characters.forEach((char, index) => {
          const halfIndex = halfCharCount - index - 1;
          const adjustmentFactor = Math.pow(halfIndex / halfCharCount, 2);
          const additionalAngle = adjustmentFactor * anglePerChar * company.adjustEllipseTextFactor;
          let indexValue = index - halfCharCount;
          let factor = indexValue / Math.abs(indexValue);
          let angle = startAngle + anglePerChar * (index + 0.5);
          let newAngle = angle + additionalAngle * factor;
          angle = newAngle;
          const x = centerX + Math.cos(angle) * (radiusX - fontSize - borderOffset);
          const y = centerY + Math.sin(angle) * (radiusY - fontSize - borderOffset);
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(angle + Math.PI / 2);
          ctx.scale(company.compression, 1);
          ctx.fillText(char, 0, 0);
          ctx.restore();
        });
      } else {
        characters.forEach((char, index) => {
          const angle = startAngle + anglePerChar * (index + 0.5);
          const x = centerX + Math.cos(angle) * (radiusX - fontSize - borderOffset);
          const y = centerY + Math.sin(angle) * (radiusY - fontSize - borderOffset);
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(angle + Math.PI / 2);
          ctx.scale(company.compression, 1);
          ctx.fillText(char, 0, 0);
          ctx.restore();
        });
      }
      ctx.restore();
    }
    /**
     * 绘制印章编码
     * @param centerX 圆心x坐标
     * @param centerY 圆心y坐标
     * @param radiusX 椭圆长轴半径
     * @param radiusY 椭圆短轴半径
     * @param text 编码文本
     * @param fontSize 字大小
     */
    drawCode(ctx, code, centerX, centerY, radiusX, radiusY) {
      const fontSize = code.fontHeight * this.mmToPixel;
      const text = code.code;
      const fontWeight = code.fontWeight || "normal";
      ctx.save();
      ctx.font = `${fontWeight} ${fontSize}px ${code.fontFamily}`;
      ctx.fillStyle = this.primaryColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const characters = text.split("");
      const characterCount = characters.length;
      const totalAngle = Math.PI * ((1 + characterCount) / code.textDistributionFactor);
      const startAngle = Math.PI / 2 + totalAngle / 2;
      const anglePerChar = totalAngle / (characterCount - 1);
      characters.forEach((char, index) => {
        const angle = startAngle - anglePerChar * index;
        const x = centerX + Math.cos(angle) * (radiusX - fontSize / 2 - code.borderOffset * this.mmToPixel);
        const y = centerY + Math.sin(angle) * (radiusY - fontSize / 2 - code.borderOffset * this.mmToPixel);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle - Math.PI / 2);
        ctx.scale(code.compression, 1);
        ctx.fillText(char, 0, 0);
        ctx.restore();
      });
      ctx.restore();
    }
    /**
     * 绘制税号
     * @param ctx 画布上下文
     * @param centerX 圆心x坐标
     * @param centerY 圆心y坐标
     */
    drawTaxNumber(ctx, taxNumber, centerX, centerY) {
      const fontSize = taxNumber.fontHeight * this.mmToPixel;
      const totalWidth = taxNumber.totalWidth * this.mmToPixel;
      const positionY = taxNumber.positionY * this.mmToPixel + 0.3;
      const fontWeight = taxNumber.fontWeight || "normal";
      ctx.save();
      ctx.font = `${fontWeight} ${fontSize}px ${taxNumber.fontFamily}`;
      ctx.fillStyle = this.primaryColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const characters = taxNumber.code.split("");
      const charCount = characters.length;
      const letterSpacing = this.drawStampConfigs.taxNumber.letterSpacing * this.mmToPixel;
      const compressedTotalWidth = totalWidth * this.drawStampConfigs.taxNumber.compression;
      const charWidth = (compressedTotalWidth - (charCount - 1) * letterSpacing) / charCount;
      const actualWidth = charCount * charWidth + (charCount - 1) * letterSpacing;
      const startX = centerX - actualWidth / 2 + charWidth / 2;
      const adjustedCenterY = centerY + positionY * this.mmToPixel;
      characters.forEach((char, index) => {
        const x = startX + index * (charWidth + letterSpacing);
        ctx.save();
        ctx.translate(x, adjustedCenterY);
        ctx.scale(this.drawStampConfigs.taxNumber.compression, 1.35);
        ctx.fillText(char, 0, 0);
        ctx.restore();
      });
      ctx.restore();
    }
    /**
     * 添加毛边效果
     * @param ctx 画布上下文
     * @param centerX 圆心x坐标
     * @param centerY 圆心y坐标
     * @param radiusX 椭圆长轴半径
     * @param radiusY 椭圆短轴半径
     * @param borderWidth 边框宽度
     */
    addRoughEdge(ctx, centerX, centerY, radiusX, radiusY, borderWidth, forceRefresh = false) {
      const roughness = borderWidth * this.drawStampConfigs.roughEdge.roughEdgeHeight * 0.01;
      const points = this.drawStampConfigs.roughEdge.roughEdgePoints;
      const outwardShift = this.drawStampConfigs.roughEdge.roughEdgeShift;
      ctx.save();
      ctx.fillStyle = "white";
      ctx.globalCompositeOperation = "destination-out";
      if (forceRefresh || this.drawStampConfigs.roughEdge.roughEdgeParams.length === 0) {
        this.drawStampConfigs.roughEdge.roughEdgeParams = [];
        for (let i = 0; i < points; i++) {
          const angle = i / points * Math.PI * 2;
          const shouldDraw = Math.random() > this.drawStampConfigs.roughEdge.roughEdgeProbability;
          const size = shouldDraw ? Math.random() * roughness * Math.random() + this.drawStampConfigs.roughEdge.roughEdgeWidth : 0;
          this.drawStampConfigs.roughEdge.roughEdgeParams.push({ angle, size });
        }
      }
      this.drawStampConfigs.roughEdge.roughEdgeParams.forEach(({ angle, size }) => {
        const x = centerX + Math.cos(angle) * (radiusX + outwardShift);
        const y = centerY + Math.sin(angle) * (radiusY + outwardShift);
        if (size > 0) {
          ctx.beginPath();
          ctx.arc(x, y, size * this.mmToPixel, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.restore();
    }
    /**
     * 添加做旧效果
     * @param width 画布宽度
     * @param height 画布高度
     * @param forceRefresh 是否强制刷新
     */
    addAgingEffect(ctx, width, height, forceRefresh = false) {
      if (!this.drawStampConfigs.agingEffect.applyAging) return;
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;
      const centerX = width / (2 * this.scale) + this.stampOffsetX * this.mmToPixel / this.scale;
      const centerY = height / (2 * this.scale) + this.stampOffsetY * this.mmToPixel / this.scale;
      const radius = Math.max(width, height) / 2 * this.mmToPixel / this.scale;
      if (forceRefresh || this.drawStampConfigs.agingEffect.agingEffectParams.length === 0) {
        this.drawStampConfigs.agingEffect.agingEffectParams = [];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const distanceFromCenter = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
            if (distanceFromCenter <= radius && data[index] > 200 && data[index + 1] < 50 && data[index + 2] < 50) {
              const intensityFactor = this.drawStampConfigs.agingEffect.agingIntensity / 100;
              const seed = Math.random();
              this.drawStampConfigs.agingEffect.agingEffectParams.push({
                x: x - this.stampOffsetX * this.mmToPixel,
                y: y - this.stampOffsetY * this.mmToPixel,
                noiseSize: Math.random() * 3 + 1,
                noise: Math.random() * 200 * intensityFactor,
                strongNoiseSize: Math.random() * 5 + 2,
                strongNoise: Math.random() * 250 * intensityFactor + 5,
                fade: Math.random() * 50 * intensityFactor,
                seed
              });
            }
          }
        }
      }
      this.drawStampConfigs.agingEffect.agingEffectParams.forEach((param) => {
        const { x, y, noiseSize, noise, strongNoiseSize, strongNoise, fade, seed } = param;
        const adjustedX = x + this.stampOffsetX * this.mmToPixel;
        const adjustedY = y + this.stampOffsetY * this.mmToPixel;
        const index = (Math.round(adjustedY) * width + Math.round(adjustedX)) * 4;
        if (seed < 0.4) {
          this.addCircularNoise(data, width, adjustedX, adjustedY, noiseSize, noise, true);
        }
        if (seed < 0.05) {
          this.addCircularNoise(data, width, adjustedX, adjustedY, strongNoiseSize, strongNoise, true);
        }
        if (seed < 0.2) {
          data[index + 3] = Math.max(0, data[index + 3] - fade);
        }
      });
      ctx.putImageData(imageData, 0, 0);
    }
    addCircularNoise(data, width, x, y, size, intensity, transparent = false) {
      const radiusSquared = size * size / 4;
      for (let dy = -size / 2; dy < size / 2; dy++) {
        for (let dx = -size / 2; dx < size / 2; dx++) {
          if (dx * dx + dy * dy <= radiusSquared) {
            const nx = Math.round(x + dx);
            const ny = Math.round(y + dy);
            const nIndex = (ny * width + nx) * 4;
            if (nIndex >= 0 && nIndex < data.length) {
              if (transparent) {
                data[nIndex + 3] = Math.max(0, data[nIndex + 3] - intensity);
              } else {
                data[nIndex] = Math.min(255, data[nIndex] + intensity);
                data[nIndex + 1] = Math.min(255, data[nIndex + 1] + intensity);
                data[nIndex + 2] = Math.min(255, data[nIndex + 2] + intensity);
              }
            }
          }
        }
      }
    }
    /**
     * 绘制全尺寸标尺
     * @param width 画布宽度
     * @param height 画布高度
     */
    drawFullRuler(ctx, width, height) {
      if (!this.ruler.showFullRuler) return;
      ctx.save();
      ctx.strokeStyle = "#bbbbbb";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      const step = this.mmToPixel * 5;
      for (let x = RULER_WIDTH; x < width; x += step * this.scale) {
        ctx.beginPath();
        ctx.moveTo(x, RULER_HEIGHT);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = RULER_HEIGHT; y < height; y += step * this.scale) {
        ctx.beginPath();
        ctx.moveTo(RULER_WIDTH, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    /**
     * 绘制标尺
     * @param rulerLength 标尺长度
     * @param rulerSize 标尺宽度
     * @param isHorizontal 是否为水平标尺
     */
    drawRuler(ctx, rulerLength, rulerSize, isHorizontal) {
      if (!this.ruler.showRuler) return;
      const mmPerPixel = 1 / this.mmToPixel;
      ctx.save();
      ctx.fillStyle = "lightgray";
      if (isHorizontal) {
        ctx.fillRect(0, 0, rulerLength, rulerSize);
      } else {
        ctx.fillRect(0, 0, rulerSize, rulerLength);
      }
      ctx.fillStyle = "black";
      ctx.font = "10px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const step = this.mmToPixel;
      const maxMM = Math.ceil((rulerLength - rulerSize) * mmPerPixel / this.scale);
      for (let mm = 0; mm <= maxMM; mm++) {
        const pos = mm * step * this.scale + rulerSize;
        if (mm % 5 === 0) {
          ctx.beginPath();
          if (isHorizontal) {
            ctx.moveTo(pos, 0);
            ctx.lineTo(pos, rulerSize * 0.8);
          } else {
            ctx.moveTo(0, pos);
            ctx.lineTo(rulerSize * 0.8, pos);
          }
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.save();
          if (isHorizontal) {
            ctx.fillText(mm.toString(), pos, rulerSize * 0.8);
          } else {
            ctx.translate(rulerSize * 0.8, pos);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(mm.toString(), 0, 0);
          }
          ctx.restore();
        } else {
          ctx.beginPath();
          if (isHorizontal) {
            ctx.moveTo(pos, 0);
            ctx.lineTo(pos, rulerSize * 0.6);
          } else {
            ctx.moveTo(0, pos);
            ctx.lineTo(rulerSize * 0.6, pos);
          }
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    /**
     * 将印章保存为PNG图片
     * @param outputSize 输出图片的尺寸
     */
    saveStampAsPNG(outputSize = 512) {
      this.drawStampConfigs.shouldDrawRuler = false;
      this.refreshStamp();
      setTimeout(() => {
        const saveCanvas = document.createElement("canvas");
        saveCanvas.width = outputSize;
        saveCanvas.height = outputSize;
        const saveCtx = saveCanvas.getContext("2d");
        if (!saveCtx) return;
        saveCtx.clearRect(0, 0, outputSize, outputSize);
        const originalStampSize = (Math.max(this.drawStampConfigs.width, this.drawStampConfigs.height) + 2) * this.mmToPixel;
        const sourceX = (this.canvas.width - originalStampSize) / 2 + this.stampOffsetX * this.mmToPixel;
        const sourceY = (this.canvas.height - originalStampSize) / 2 + this.stampOffsetY * this.mmToPixel;
        const margin = outputSize * 0.01;
        const drawSize = outputSize - 2 * margin;
        saveCtx.drawImage(
          this.canvas,
          sourceX,
          sourceY,
          originalStampSize,
          originalStampSize,
          margin,
          margin,
          drawSize,
          drawSize
        );
        if (this.drawStampConfigs.agingEffect.applyAging) {
          this.addAgingEffect(saveCtx, outputSize, outputSize, false);
        }
        const dataURL = saveCanvas.toDataURL("image/png");
        const link = document.createElement("a");
        link.href = dataURL;
        link.download = "\u5370\u7AE0.png";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        this.drawStampConfigs.shouldDrawRuler = true;
        this.refreshStamp();
      }, 50);
    }
    // 刷新印章绘制
    refreshStamp(refreshSecurityPattern = false, refreshOld = false) {
      this.canvasCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.canvasCtx.save();
      this.canvasCtx.translate(this.offsetX, this.offsetY);
      this.canvasCtx.scale(this.scale, this.scale);
      const x = this.canvas.width / 2 / this.scale;
      const y = this.canvas.height / 2 / this.scale;
      const mmToPixel = this.mmToPixel;
      const drawRadiusX = (this.drawStampConfigs.width - this.drawStampConfigs.borderWidth) / 2;
      const drawRadiusY = (this.drawStampConfigs.height - this.drawStampConfigs.borderWidth) / 2;
      const offsetX = this.stampOffsetX * this.mmToPixel;
      const offsetY = this.stampOffsetY * this.mmToPixel;
      const centerX = x + offsetX;
      const centerY = y + offsetY;
      this.drawStamp(
        this.canvasCtx,
        centerX,
        centerY,
        drawRadiusX * mmToPixel,
        drawRadiusY * mmToPixel,
        this.drawStampConfigs.borderWidth * mmToPixel,
        this.drawStampConfigs.primaryColor,
        refreshSecurityPattern,
        refreshOld
      );
      this.canvasCtx.restore();
      if (this.drawStampConfigs.shouldDrawRuler) {
        this.drawRuler(this.canvasCtx, this.canvas.width, RULER_HEIGHT, true);
        this.drawRuler(this.canvasCtx, this.canvas.height, RULER_HEIGHT, false);
        this.drawFullRuler(this.canvasCtx, this.canvas.width, this.canvas.height);
      }
    }
    /**
     * 重置缩放比例为100%
     */
    resetZoom() {
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.refreshStamp();
    }
    // 添加绘制公司列表的方法
    drawCompanyList(ctx, companyList, centerX, centerY, radiusX, radiusY) {
      companyList.forEach((company) => {
        this.drawCompanyName(ctx, company, centerX, centerY, radiusX, radiusY);
      });
    }
    // 绘制内圈列表
    drawInnerCircleList(ctx, centerX, centerY, borderColor) {
      const innerCircleList = this.drawStampConfigs.innerCircleList;
      innerCircleList.forEach((innerCircle) => {
        if (innerCircle.drawInnerCircle) {
          this.drawInnerCircle(ctx, centerX, centerY, borderColor, innerCircle);
        }
      });
    }
    // 绘制内圈
    drawInnerCircle(ctx, centerX, centerY, borderColor, innerCircle) {
      const innerCircleWidth = (innerCircle.innerCircleLineRadiusX - innerCircle.innerCircleLineWidth) / 2;
      const innerCircleHeight = (innerCircle.innerCircleLineRadiusY - innerCircle.innerCircleLineWidth) / 2;
      this.drawEllipse(
        ctx,
        centerX,
        centerY,
        innerCircleWidth * this.mmToPixel,
        innerCircleHeight * this.mmToPixel,
        innerCircle.innerCircleLineWidth * this.mmToPixel,
        borderColor
      );
    }
    /**
     * 绘制印章
     * @param x 圆心x坐标
     * @param y 圆心y坐标
     * @param radiusX 半径x
     * @param radiusY 半径y
     * @param borderWidth 边框宽度
     * @param borderColor 边框颜色
     */
    drawStamp(ctx, centerX, centerY, radiusX, radiusY, borderWidth, borderColor, refreshSecurityPattern = false, refreshOld = false) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const offscreenCanvas = this.offscreenCanvas;
      offscreenCanvas.width = this.canvas.width;
      offscreenCanvas.height = this.canvas.height;
      const offscreenCtx = offscreenCanvas.getContext("2d");
      if (!offscreenCtx) return;
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = this.canvas.width;
      tempCanvas.height = this.canvas.height;
      const tempCtx = tempCanvas.getContext("2d");
      if (!tempCtx) return;
      if (this.drawStampConfigs.drawStar.drawStar && this.drawStampConfigs.drawStar.useImage) {
        this.drawStarShape(tempCtx, this.drawStampConfigs.drawStar, centerX, centerY);
      }
      offscreenCtx.beginPath();
      offscreenCtx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      offscreenCtx.strokeStyle = borderColor;
      offscreenCtx.lineWidth = borderWidth;
      offscreenCtx.stroke();
      offscreenCtx.save();
      offscreenCtx.beginPath();
      offscreenCtx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      offscreenCtx.clip();
      if (this.drawStampConfigs.innerCircleList.length > 0) {
        this.drawInnerCircleList(offscreenCtx, centerX, centerY, borderColor);
      }
      this.drawSecurityPattern(offscreenCtx, centerX, centerY, radiusX, radiusY, refreshSecurityPattern);
      if (this.drawStampConfigs.drawStar.drawStar && !this.drawStampConfigs.drawStar.useImage) {
        this.drawStarShape(offscreenCtx, this.drawStampConfigs.drawStar, centerX, centerY);
      }
      this.drawCompanyList(offscreenCtx, this.drawStampConfigs.companyList, centerX, centerY, radiusX, radiusY);
      this.drawStampTypeList(offscreenCtx, this.drawStampConfigs.stampTypeList, centerX, centerY, radiusX);
      this.drawCode(offscreenCtx, this.drawStampConfigs.stampCode, centerX, centerY, radiusX, radiusY);
      this.drawTaxNumber(offscreenCtx, this.drawStampConfigs.taxNumber, centerX, centerY);
      offscreenCtx.restore();
      ctx.save();
      if (this.drawStampConfigs.drawStar.drawStar && this.drawStampConfigs.drawStar.useImage) {
        ctx.drawImage(tempCanvas, 0, 0);
      }
      if (this.drawStampConfigs.roughEdge.drawRoughEdge) {
        this.addRoughEdge(offscreenCtx, centerX, centerY, radiusX, radiusY, borderWidth, refreshOld);
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(offscreenCanvas, 0, 0);
      ctx.restore();
      if (this.drawStampConfigs.agingEffect.applyAging) {
        this.addAgingEffect(ctx, this.canvas.width, this.canvas.height, refreshOld);
      }
      if (this.drawStampConfigs.shouldDrawRuler) {
        this.drawRuler(ctx, this.canvas.width, RULER_HEIGHT, true);
        this.drawRuler(ctx, this.canvas.height, RULER_HEIGHT, false);
        this.drawFullRuler(ctx, this.canvas.width, this.canvas.height);
      }
    }
    // 添加清理缓存的方法
    async clearImageCache() {
      for (const bitmap of this.imageCache.values()) {
        bitmap.close();
      }
      this.imageCache.clear();
    }
    // 在设置新的图片URL时清除旧的缓存
    async updateStarImage(imageUrl) {
      console.log("Updating star image:", imageUrl);
      await this.clearImageCache();
      this.drawStampConfigs.drawStar.imageUrl = imageUrl;
      this.drawStampConfigs.drawStar.useImage = true;
      this.drawStampConfigs.drawStar.drawStar = true;
      this.refreshStamp();
    }
  };
  return __toCommonJS(DrawStampUtils_exports);
})();
