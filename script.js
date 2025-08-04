// script.js (All-in-one Client-Side Version)

// =========================================================================
// == 第三方库源代码 (直接粘贴在这里)
// =========================================================================

// --- 1. jpeg-js (decoder.js) ---
// The full source code of jpeg-js's decoder.js goes here.
// e.g., from https://raw.githubusercontent.com/jpeg-js/jpeg-js/master/lib/decoder.js
// It will create a global variable `jpeg`.
var jpeg = (function() {
    /* -*- tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- /
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/*
   Copyright 2011 notmasteryet

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

// - The JPEG specification can be found in the ITU CCITT Recommendation T.81
//   (www.w3.org/Graphics/JPEG/itu-t81.pdf)
// - The JFIF specification can be found in the JPEG File Interchange Format
//   (www.w3.org/Graphics/JPEG/jfif3.pdf)
// - The Adobe Application-Specific JPEG markers in the Supporting the DCT Filters
//   in PostScript Level 2, Technical Note #5116
//   (partners.adobe.com/public/developer/en/ps/sdk/5116.DCT_Filter.pdf)

var JpegImage = (function jpegImage() {
  "use strict";
  var dctZigZag = new Int32Array([
     0,
     1,  8,
    16,  9,  2,
     3, 10, 17, 24,
    32, 25, 18, 11, 4,
     5, 12, 19, 26, 33, 40,
    48, 41, 34, 27, 20, 13,  6,
     7, 14, 21, 28, 35, 42, 49, 56,
    57, 50, 43, 36, 29, 22, 15,
    23, 30, 37, 44, 51, 58,
    59, 52, 45, 38, 31,
    39, 46, 53, 60,
    61, 54, 47,
    55, 62,
    63
  ]);

  var dctCos1  =  4017   // cos(pi/16)
  var dctSin1  =   799   // sin(pi/16)
  var dctCos3  =  3406   // cos(3*pi/16)
  var dctSin3  =  2276   // sin(3*pi/16)
  var dctCos6  =  1567   // cos(6*pi/16)
  var dctSin6  =  3784   // sin(6*pi/16)
  var dctSqrt2 =  5793   // sqrt(2)
  var dctSqrt1d2 = 2896  // sqrt(2) / 2

  function constructor() {
  }

  function buildHuffmanTable(codeLengths, values) {
    var k = 0, code = [], i, j, length = 16;
    while (length > 0 && !codeLengths[length - 1])
      length--;
    code.push({children: [], index: 0});
    var p = code[0], q;
    for (i = 0; i < length; i++) {
      for (j = 0; j < codeLengths[i]; j++) {
        p = code.pop();
        p.children[p.index] = values[k];
        while (p.index > 0) {
          if (code.length === 0)
            throw new Error('Could not recreate Huffman Table');
          p = code.pop();
        }
        p.index++;
        code.push(p);
        while (code.length <= i) {
          code.push(q = {children: [], index: 0});
          p.children[p.index] = q.children;
          p = q;
        }
        k++;
      }
      if (i + 1 < length) {
        // p here points to last code
        code.push(q = {children: [], index: 0});
        p.children[p.index] = q.children;
        p = q;
      }
    }
    return code[0].children;
  }

  function decodeScan(data, offset,
                      frame, components, resetInterval,
                      spectralStart, spectralEnd,
                      successivePrev, successive, opts) {
    var mcusPerLine = frame.mcusPerLine;
    var progressive = frame.progressive;

    var startOffset = offset, bitsData = 0, bitsCount = 0;
    function readBit() {
      if (bitsCount > 0) {
        bitsCount--;
        return (bitsData >> bitsCount) & 1;
      }
      bitsData = data[offset++];
      if (bitsData == 0xFF) {
        var nextByte = data[offset++];
        if (nextByte) {
          throw new Error("unexpected marker: " + ((bitsData << 8) | nextByte).toString(16));
        }
        // unstuff 0
      }
      bitsCount = 7;
      return bitsData >>> 7;
    }
    function decodeHuffman(tree) {
      var node = tree, bit;
      while ((bit = readBit()) !== null) {
        node = node[bit];
        if (typeof node === 'number')
          return node;
        if (typeof node !== 'object')
          throw new Error("invalid huffman sequence");
      }
      return null;
    }
    function receive(length) {
      var n = 0;
      while (length > 0) {
        var bit = readBit();
        if (bit === null) return;
        n = (n << 1) | bit;
        length--;
      }
      return n;
    }
    function receiveAndExtend(length) {
      var n = receive(length);
      if (n >= 1 << (length - 1))
        return n;
      return n + (-1 << length) + 1;
    }
    function decodeBaseline(component, zz) {
      var t = decodeHuffman(component.huffmanTableDC);
      var diff = t === 0 ? 0 : receiveAndExtend(t);
      zz[0]= (component.pred += diff);
      var k = 1;
      while (k < 64) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15)
            break;
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        zz[z] = receiveAndExtend(s);
        k++;
      }
    }
    function decodeDCFirst(component, zz) {
      var t = decodeHuffman(component.huffmanTableDC);
      var diff = t === 0 ? 0 : (receiveAndExtend(t) << successive);
      zz[0] = (component.pred += diff);
    }
    function decodeDCSuccessive(component, zz) {
      zz[0] |= readBit() << successive;
    }
    var eobrun = 0;
    function decodeACFirst(component, zz) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      var k = spectralStart, e = spectralEnd;
      while (k <= e) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eobrun = receive(r) + (1 << r) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        zz[z] = receiveAndExtend(s) * (1 << successive);
        k++;
      }
    }
    var successiveACState = 0, successiveACNextValue;
    function decodeACSuccessive(component, zz) {
      var k = spectralStart, e = spectralEnd, r = 0;
      while (k <= e) {
        var z = dctZigZag[k];
        var direction = zz[z] < 0 ? -1 : 1;
        switch (successiveACState) {
        case 0: // initial state
          var rs = decodeHuffman(component.huffmanTableAC);
          var s = rs & 15, r = rs >> 4;
          if (s === 0) {
            if (r < 15) {
              eobrun = receive(r) + (1 << r);
              successiveACState = 4;
            } else {
              r = 16;
              successiveACState = 1;
            }
          } else {
            if (s !== 1)
              throw new Error("invalid ACn encoding");
            successiveACNextValue = receiveAndExtend(s);
            successiveACState = r ? 2 : 3;
          }
          continue;
        case 1: // skipping r zero items
        case 2:
          if (zz[z])
            zz[z] += (readBit() << successive) * direction;
          else {
            r--;
            if (r === 0)
              successiveACState = successiveACState == 2 ? 3 : 0;
          }
          break;
        case 3: // set value for a zero item
          if (zz[z])
            zz[z] += (readBit() << successive) * direction;
          else {
            zz[z] = successiveACNextValue << successive;
            successiveACState = 0;
          }
          break;
        case 4: // eob
          if (zz[z])
            zz[z] += (readBit() << successive) * direction;
          break;
        }
        k++;
      }
      if (successiveACState === 4) {
        eobrun--;
        if (eobrun === 0)
          successiveACState = 0;
      }
    }
    function decodeMcu(component, decode, mcu, row, col) {
      var mcuRow = (mcu / mcusPerLine) | 0;
      var mcuCol = mcu % mcusPerLine;
      var blockRow = mcuRow * component.v + row;
      var blockCol = mcuCol * component.h + col;
      // If the block is missing and we're in tolerant mode, just skip it.
      if (component.blocks[blockRow] === undefined && opts.tolerantDecoding)
        return;
      decode(component, component.blocks[blockRow][blockCol]);
    }
    function decodeBlock(component, decode, mcu) {
      var blockRow = (mcu / component.blocksPerLine) | 0;
      var blockCol = mcu % component.blocksPerLine;
      // If the block is missing and we're in tolerant mode, just skip it.
      if (component.blocks[blockRow] === undefined && opts.tolerantDecoding)
        return;
      decode(component, component.blocks[blockRow][blockCol]);
    }

    var componentsLength = components.length;
    var component, i, j, k, n;
    var decodeFn;
    if (progressive) {
      if (spectralStart === 0)
        decodeFn = successivePrev === 0 ? decodeDCFirst : decodeDCSuccessive;
      else
        decodeFn = successivePrev === 0 ? decodeACFirst : decodeACSuccessive;
    } else {
      decodeFn = decodeBaseline;
    }

    var mcu = 0, marker;
    var mcuExpected;
    if (componentsLength == 1) {
      mcuExpected = components[0].blocksPerLine * components[0].blocksPerColumn;
    } else {
      mcuExpected = mcusPerLine * frame.mcusPerColumn;
    }
    if (!resetInterval) resetInterval = mcuExpected;

    var h, v;
    while (mcu < mcuExpected) {
      // reset interval stuff
      for (i = 0; i < componentsLength; i++)
        components[i].pred = 0;
      eobrun = 0;

      if (componentsLength == 1) {
        component = components[0];
        for (n = 0; n < resetInterval; n++) {
          decodeBlock(component, decodeFn, mcu);
          mcu++;
        }
      } else {
        for (n = 0; n < resetInterval; n++) {
          for (i = 0; i < componentsLength; i++) {
            component = components[i];
            h = component.h;
            v = component.v;
            for (j = 0; j < v; j++) {
              for (k = 0; k < h; k++) {
                decodeMcu(component, decodeFn, mcu, j, k);
              }
            }
          }
          mcu++;

          // If we've reached our expected MCU's, stop decoding
          if (mcu === mcuExpected) break;
        }
      }

      if (mcu === mcuExpected) {
        // Skip trailing bytes at the end of the scan - until we reach the next marker
        do {
          if (data[offset] === 0xFF) {
            if (data[offset + 1] !== 0x00) {
              break;
            }
          }
          offset += 1;
        } while (offset < data.length - 2);
      }

      // find marker
      bitsCount = 0;
      marker = (data[offset] << 8) | data[offset + 1];
      if (marker < 0xFF00) {
        throw new Error("marker was not found");
      }

      if (marker >= 0xFFD0 && marker <= 0xFFD7) { // RSTx
        offset += 2;
      }
      else
        break;
    }

    return offset - startOffset;
  }

  function buildComponentData(component) {
    var lines = [];
    var blocksPerLine = component.blocksPerLine;
    var blocksPerColumn = component.blocksPerColumn;
    var samplesPerLine = blocksPerLine << 3;
    // Only 1 used per invocation of this function and garbage collected after invocation, so no need to account for its memory footprint.
    var R = new Int32Array(64), r = new Uint8Array(64);

    // A port of poppler's IDCT method which in turn is taken from:
    //   Christoph Loeffler, Adriaan Ligtenberg, George S. Moschytz,
    //   "Practical Fast 1-D DCT Algorithms with 11 Multiplications",
    //   IEEE Intl. Conf. on Acoustics, Speech & Signal Processing, 1989,
    //   988-991.
    function quantizeAndInverse(zz, dataOut, dataIn) {
      var qt = component.quantizationTable;
      var v0, v1, v2, v3, v4, v5, v6, v7, t;
      var p = dataIn;
      var i;

      // dequant
      for (i = 0; i < 64; i++)
        p[i] = zz[i] * qt[i];

      // inverse DCT on rows
      for (i = 0; i < 8; ++i) {
        var row = 8 * i;

        // check for all-zero AC coefficients
        if (p[1 + row] == 0 && p[2 + row] == 0 && p[3 + row] == 0 &&
            p[4 + row] == 0 && p[5 + row] == 0 && p[6 + row] == 0 &&
            p[7 + row] == 0) {
          t = (dctSqrt2 * p[0 + row] + 512) >> 10;
          p[0 + row] = t;
          p[1 + row] = t;
          p[2 + row] = t;
          p[3 + row] = t;
          p[4 + row] = t;
          p[5 + row] = t;
          p[6 + row] = t;
          p[7 + row] = t;
          continue;
        }

        // stage 4
        v0 = (dctSqrt2 * p[0 + row] + 128) >> 8;
        v1 = (dctSqrt2 * p[4 + row] + 128) >> 8;
        v2 = p[2 + row];
        v3 = p[6 + row];
        v4 = (dctSqrt1d2 * (p[1 + row] - p[7 + row]) + 128) >> 8;
        v7 = (dctSqrt1d2 * (p[1 + row] + p[7 + row]) + 128) >> 8;
        v5 = p[3 + row] << 4;
        v6 = p[5 + row] << 4;

        // stage 3
        t = (v0 - v1+ 1) >> 1;
        v0 = (v0 + v1 + 1) >> 1;
        v1 = t;
        t = (v2 * dctSin6 + v3 * dctCos6 + 128) >> 8;
        v2 = (v2 * dctCos6 - v3 * dctSin6 + 128) >> 8;
        v3 = t;
        t = (v4 - v6 + 1) >> 1;
        v4 = (v4 + v6 + 1) >> 1;
        v6 = t;
        t = (v7 + v5 + 1) >> 1;
        v5 = (v7 - v5 + 1) >> 1;
        v7 = t;

        // stage 2
        t = (v0 - v3 + 1) >> 1;
        v0 = (v0 + v3 + 1) >> 1;
        v3 = t;
        t = (v1 - v2 + 1) >> 1;
        v1 = (v1 + v2 + 1) >> 1;
        v2 = t;
        t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
        v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
        v7 = t;
        t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
        v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
        v6 = t;

        // stage 1
        p[0 + row] = v0 + v7;
        p[7 + row] = v0 - v7;
        p[1 + row] = v1 + v6;
        p[6 + row] = v1 - v6;
        p[2 + row] = v2 + v5;
        p[5 + row] = v2 - v5;
        p[3 + row] = v3 + v4;
        p[4 + row] = v3 - v4;
      }

      // inverse DCT on columns
      for (i = 0; i < 8; ++i) {
        var col = i;

        // check for all-zero AC coefficients
        if (p[1*8 + col] == 0 && p[2*8 + col] == 0 && p[3*8 + col] == 0 &&
            p[4*8 + col] == 0 && p[5*8 + col] == 0 && p[6*8 + col] == 0 &&
            p[7*8 + col] == 0) {
          t = (dctSqrt2 * dataIn[i+0] + 8192) >> 14;
          p[0*8 + col] = t;
          p[1*8 + col] = t;
          p[2*8 + col] = t;
          p[3*8 + col] = t;
          p[4*8 + col] = t;
          p[5*8 + col] = t;
          p[6*8 + col] = t;
          p[7*8 + col] = t;
          continue;
        }

        // stage 4
        v0 = (dctSqrt2 * p[0*8 + col] + 2048) >> 12;
        v1 = (dctSqrt2 * p[4*8 + col] + 2048) >> 12;
        v2 = p[2*8 + col];
        v3 = p[6*8 + col];
        v4 = (dctSqrt1d2 * (p[1*8 + col] - p[7*8 + col]) + 2048) >> 12;
        v7 = (dctSqrt1d2 * (p[1*8 + col] + p[7*8 + col]) + 2048) >> 12;
        v5 = p[3*8 + col];
        v6 = p[5*8 + col];

        // stage 3
        t = (v0 - v1 + 1) >> 1;
        v0 = (v0 + v1 + 1) >> 1;
        v1 = t;
        t = (v2 * dctSin6 + v3 * dctCos6 + 2048) >> 12;
        v2 = (v2 * dctCos6 - v3 * dctSin6 + 2048) >> 12;
        v3 = t;
        t = (v4 - v6 + 1) >> 1;
        v4 = (v4 + v6 + 1) >> 1;
        v6 = t;
        t = (v7 + v5 + 1) >> 1;
        v5 = (v7 - v5 + 1) >> 1;
        v7 = t;

        // stage 2
        t = (v0 - v3 + 1) >> 1;
        v0 = (v0 + v3 + 1) >> 1;
        v3 = t;
        t = (v1 - v2 + 1) >> 1;
        v1 = (v1 + v2 + 1) >> 1;
        v2 = t;
        t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
        v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
        v7 = t;
        t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
        v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
        v6 = t;

        // stage 1
        p[0*8 + col] = v0 + v7;
        p[7*8 + col] = v0 - v7;
        p[1*8 + col] = v1 + v6;
        p[6*8 + col] = v1 - v6;
        p[2*8 + col] = v2 + v5;
        p[5*8 + col] = v2 - v5;
        p[3*8 + col] = v3 + v4;
        p[4*8 + col] = v3 - v4;
      }

      // convert to 8-bit integers
      for (i = 0; i < 64; ++i) {
        var sample = 128 + ((p[i] + 8) >> 4);
        dataOut[i] = sample < 0 ? 0 : sample > 0xFF ? 0xFF : sample;
      }
    }

    requestMemoryAllocation(samplesPerLine * blocksPerColumn * 8);

    var i, j;
    for (var blockRow = 0; blockRow < blocksPerColumn; blockRow++) {
      var scanLine = blockRow << 3;
      for (i = 0; i < 8; i++)
        lines.push(new Uint8Array(samplesPerLine));
      for (var blockCol = 0; blockCol < blocksPerLine; blockCol++) {
        quantizeAndInverse(component.blocks[blockRow][blockCol], r, R);

        var offset = 0, sample = blockCol << 3;
        for (j = 0; j < 8; j++) {
          var line = lines[scanLine + j];
          for (i = 0; i < 8; i++)
            line[sample + i] = r[offset++];
        }
      }
    }
    return lines;
  }

  function clampTo8bit(a) {
    return a < 0 ? 0 : a > 255 ? 255 : a;
  }

  constructor.prototype = {
    load: function load(path) {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", path, true);
      xhr.responseType = "arraybuffer";
      xhr.onload = (function() {
        // TODO catch parse error
        var data = new Uint8Array(xhr.response || xhr.mozResponseArrayBuffer);
        this.parse(data);
        if (this.onload)
          this.onload();
      }).bind(this);
      xhr.send(null);
    },
    parse: function parse(data) {
      var maxResolutionInPixels = this.opts.maxResolutionInMP * 1000 * 1000;
      var offset = 0, length = data.length;
      function readUint16() {
        var value = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        return value;
      }
      function readDataBlock() {
        var length = readUint16();
        var array = data.subarray(offset, offset + length - 2);
        offset += array.length;
        return array;
      }
      function prepareComponents(frame) {
        // According to the JPEG standard, the sampling factor must be between 1 and 4
        // See https://github.com/libjpeg-turbo/libjpeg-turbo/blob/9abeff46d87bd201a952e276f3e4339556a403a3/libjpeg.txt#L1138-L1146
        var maxH = 1, maxV = 1;
        var component, componentId;
        for (componentId in frame.components) {
          if (frame.components.hasOwnProperty(componentId)) {
            component = frame.components[componentId];
            if (maxH < component.h) maxH = component.h;
            if (maxV < component.v) maxV = component.v;
          }
        }
        var mcusPerLine = Math.ceil(frame.samplesPerLine / 8 / maxH);
        var mcusPerColumn = Math.ceil(frame.scanLines / 8 / maxV);
        for (componentId in frame.components) {
          if (frame.components.hasOwnProperty(componentId)) {
            component = frame.components[componentId];
            var blocksPerLine = Math.ceil(Math.ceil(frame.samplesPerLine / 8) * component.h / maxH);
            var blocksPerColumn = Math.ceil(Math.ceil(frame.scanLines  / 8) * component.v / maxV);
            var blocksPerLineForMcu = mcusPerLine * component.h;
            var blocksPerColumnForMcu = mcusPerColumn * component.v;
            var blocksToAllocate = blocksPerColumnForMcu * blocksPerLineForMcu;
            var blocks = [];

            // Each block is a Int32Array of length 64 (4 x 64 = 256 bytes)
            requestMemoryAllocation(blocksToAllocate * 256);

            for (var i = 0; i < blocksPerColumnForMcu; i++) {
              var row = [];
              for (var j = 0; j < blocksPerLineForMcu; j++)
                row.push(new Int32Array(64));
              blocks.push(row);
            }
            component.blocksPerLine = blocksPerLine;
            component.blocksPerColumn = blocksPerColumn;
            component.blocks = blocks;
          }
        }
        frame.maxH = maxH;
        frame.maxV = maxV;
        frame.mcusPerLine = mcusPerLine;
        frame.mcusPerColumn = mcusPerColumn;
      }
      var jfif = null;
      var adobe = null;
      var frame, resetInterval;
      var quantizationTables = [], frames = [];
      var huffmanTablesAC = [], huffmanTablesDC = [];
      var fileMarker = readUint16();
      var malformedDataOffset = -1;
      this.comments = [];
      if (fileMarker != 0xFFD8) { // SOI (Start of Image)
        throw new Error("SOI not found");
      }

      fileMarker = readUint16();
      while (fileMarker != 0xFFD9) { // EOI (End of image)
        var i, j;
        switch(fileMarker) {
          case 0xFF00: break;
          case 0xFFE0: // APP0 (Application Specific)
          case 0xFFE1: // APP1
          case 0xFFE2: // APP2
          case 0xFFE3: // APP3
          case 0xFFE4: // APP4
          case 0xFFE5: // APP5
          case 0xFFE6: // APP6
          case 0xFFE7: // APP7
          case 0xFFE8: // APP8
          case 0xFFE9: // APP9
          case 0xFFEA: // APP10
          case 0xFFEB: // APP11
          case 0xFFEC: // APP12
          case 0xFFED: // APP13
          case 0xFFEE: // APP14
          case 0xFFEF: // APP15
          case 0xFFFE: // COM (Comment)
            var appData = readDataBlock();

            if (fileMarker === 0xFFFE) {
              var comment = String.fromCharCode.apply(null, appData);
              this.comments.push(comment);
            }

            if (fileMarker === 0xFFE0) {
              if (appData[0] === 0x4A && appData[1] === 0x46 && appData[2] === 0x49 &&
                appData[3] === 0x46 && appData[4] === 0) { // 'JFIF\x00'
                jfif = {
                  version: { major: appData[5], minor: appData[6] },
                  densityUnits: appData[7],
                  xDensity: (appData[8] << 8) | appData[9],
                  yDensity: (appData[10] << 8) | appData[11],
                  thumbWidth: appData[12],
                  thumbHeight: appData[13],
                  thumbData: appData.subarray(14, 14 + 3 * appData[12] * appData[13])
                };
              }
            }
            // TODO APP1 - Exif
            if (fileMarker === 0xFFE1) {
              if (appData[0] === 0x45 &&
                appData[1] === 0x78 &&
                appData[2] === 0x69 &&
                appData[3] === 0x66 &&
                appData[4] === 0) { // 'EXIF\x00'
                this.exifBuffer = appData.subarray(5, appData.length);
              }
            }

            if (fileMarker === 0xFFEE) {
              if (appData[0] === 0x41 && appData[1] === 0x64 && appData[2] === 0x6F &&
                appData[3] === 0x62 && appData[4] === 0x65 && appData[5] === 0) { // 'Adobe\x00'
                adobe = {
                  version: appData[6],
                  flags0: (appData[7] << 8) | appData[8],
                  flags1: (appData[9] << 8) | appData[10],
                  transformCode: appData[11]
                };
              }
            }
            break;

          case 0xFFDB: // DQT (Define Quantization Tables)
            var quantizationTablesLength = readUint16();
            var quantizationTablesEnd = quantizationTablesLength + offset - 2;
            while (offset < quantizationTablesEnd) {
              var quantizationTableSpec = data[offset++];
              requestMemoryAllocation(64 * 4);
              var tableData = new Int32Array(64);
              if ((quantizationTableSpec >> 4) === 0) { // 8 bit values
                for (j = 0; j < 64; j++) {
                  var z = dctZigZag[j];
                  tableData[z] = data[offset++];
                }
              } else if ((quantizationTableSpec >> 4) === 1) { //16 bit
                for (j = 0; j < 64; j++) {
                  var z = dctZigZag[j];
                  tableData[z] = readUint16();
                }
              } else
                throw new Error("DQT: invalid table spec");
              quantizationTables[quantizationTableSpec & 15] = tableData;
            }
            break;

          case 0xFFC0: // SOF0 (Start of Frame, Baseline DCT)
          case 0xFFC1: // SOF1 (Start of Frame, Extended DCT)
          case 0xFFC2: // SOF2 (Start of Frame, Progressive DCT)
            readUint16(); // skip data length
            frame = {};
            frame.extended = (fileMarker === 0xFFC1);
            frame.progressive = (fileMarker === 0xFFC2);
            frame.precision = data[offset++];
            frame.scanLines = readUint16();
            frame.samplesPerLine = readUint16();
            frame.components = {};
            frame.componentsOrder = [];

            var pixelsInFrame = frame.scanLines * frame.samplesPerLine;
            if (pixelsInFrame > maxResolutionInPixels) {
              var exceededAmount = Math.ceil((pixelsInFrame - maxResolutionInPixels) / 1e6);
              throw new Error(`maxResolutionInMP limit exceeded by ${exceededAmount}MP`);
            }

            var componentsCount = data[offset++], componentId;
            for (i = 0; i < componentsCount; i++) {
              componentId = data[offset];
              var h = data[offset + 1] >> 4;
              var v = data[offset + 1] & 15;
              var qId = data[offset + 2];

              if ( h <= 0 || v <= 0 ) {
                throw new Error('Invalid sampling factor, expected values above 0');
              }

              frame.componentsOrder.push(componentId);
              frame.components[componentId] = {
                h: h,
                v: v,
                quantizationIdx: qId
              };
              offset += 3;
            }
            prepareComponents(frame);
            frames.push(frame);
            break;

          case 0xFFC4: // DHT (Define Huffman Tables)
            var huffmanLength = readUint16();
            for (i = 2; i < huffmanLength;) {
              var huffmanTableSpec = data[offset++];
              var codeLengths = new Uint8Array(16);
              var codeLengthSum = 0;
              for (j = 0; j < 16; j++, offset++) {
                codeLengthSum += (codeLengths[j] = data[offset]);
              }
              requestMemoryAllocation(16 + codeLengthSum);
              var huffmanValues = new Uint8Array(codeLengthSum);
              for (j = 0; j < codeLengthSum; j++, offset++)
                huffmanValues[j] = data[offset];
              i += 17 + codeLengthSum;

              ((huffmanTableSpec >> 4) === 0 ?
                huffmanTablesDC : huffmanTablesAC)[huffmanTableSpec & 15] =
                buildHuffmanTable(codeLengths, huffmanValues);
            }
            break;

          case 0xFFDD: // DRI (Define Restart Interval)
            readUint16(); // skip data length
            resetInterval = readUint16();
            break;

          case 0xFFDC: // Number of Lines marker
            readUint16() // skip data length
            readUint16() // Ignore this data since it represents the image height
            break;
            
          case 0xFFDA: // SOS (Start of Scan)
            var scanLength = readUint16();
            var selectorsCount = data[offset++];
            var components = [], component;
            for (i = 0; i < selectorsCount; i++) {
              component = frame.components[data[offset++]];
              var tableSpec = data[offset++];
              component.huffmanTableDC = huffmanTablesDC[tableSpec >> 4];
              component.huffmanTableAC = huffmanTablesAC[tableSpec & 15];
              components.push(component);
            }
            var spectralStart = data[offset++];
            var spectralEnd = data[offset++];
            var successiveApproximation = data[offset++];
            var processed = decodeScan(data, offset,
              frame, components, resetInterval,
              spectralStart, spectralEnd,
              successiveApproximation >> 4, successiveApproximation & 15, this.opts);
            offset += processed;
            break;

          case 0xFFFF: // Fill bytes
            if (data[offset] !== 0xFF) { // Avoid skipping a valid marker.
              offset--;
            }
            break;
          default:
            if (data[offset - 3] == 0xFF &&
                data[offset - 2] >= 0xC0 && data[offset - 2] <= 0xFE) {
              // could be incorrect encoding -- last 0xFF byte of the previous
              // block was eaten by the encoder
              offset -= 3;
              break;
            }
            else if (fileMarker === 0xE0 || fileMarker == 0xE1) {
              // Recover from malformed APP1 markers popular in some phone models.
              // See https://github.com/eugeneware/jpeg-js/issues/82
              if (malformedDataOffset !== -1) {
                throw new Error(`first unknown JPEG marker at offset ${malformedDataOffset.toString(16)}, second unknown JPEG marker ${fileMarker.toString(16)} at offset ${(offset - 1).toString(16)}`);
              }
              malformedDataOffset = offset - 1;
              const nextOffset = readUint16();
              if (data[offset + nextOffset - 2] === 0xFF) {
                offset += nextOffset - 2;
                break;
              }
            }
            throw new Error("unknown JPEG marker " + fileMarker.toString(16));
        }
        fileMarker = readUint16();
      }
      if (frames.length != 1)
        throw new Error("only single frame JPEGs supported");

      // set each frame's components quantization table
      for (var i = 0; i < frames.length; i++) {
        var cp = frames[i].components;
        for (var j in cp) {
          cp[j].quantizationTable = quantizationTables[cp[j].quantizationIdx];
          delete cp[j].quantizationIdx;
        }
      }

      this.width = frame.samplesPerLine;
      this.height = frame.scanLines;
      this.jfif = jfif;
      this.adobe = adobe;
      this.components = [];
      for (var i = 0; i < frame.componentsOrder.length; i++) {
        var component = frame.components[frame.componentsOrder[i]];
        this.components.push({
          lines: buildComponentData(component),
          scaleX: component.h / frame.maxH,
          scaleY: component.v / frame.maxV
        });
      }
    },
    getData: function getData(width, height) {
      var scaleX = this.width / width, scaleY = this.height / height;

      var component1, component2, component3, component4;
      var component1Line, component2Line, component3Line, component4Line;
      var x, y;
      var offset = 0;
      var Y, Cb, Cr, K, C, M, Ye, R, G, B;
      var colorTransform;
      var dataLength = width * height * this.components.length;
      requestMemoryAllocation(dataLength);
      var data = new Uint8Array(dataLength);
      switch (this.components.length) {
        case 1:
          component1 = this.components[0];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              Y = component1Line[0 | (x * component1.scaleX * scaleX)];

              data[offset++] = Y;
            }
          }
          break;
        case 2:
          // PDF might compress two component data in custom colorspace
          component1 = this.components[0];
          component2 = this.components[1];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              Y = component1Line[0 | (x * component1.scaleX * scaleX)];
              data[offset++] = Y;
              Y = component2Line[0 | (x * component2.scaleX * scaleX)];
              data[offset++] = Y;
            }
          }
          break;
        case 3:
          // The default transform for three components is true
          colorTransform = true;
          // The adobe transform marker overrides any previous setting
          if (this.adobe && this.adobe.transformCode)
            colorTransform = true;
          else if (typeof this.opts.colorTransform !== 'undefined')
            colorTransform = !!this.opts.colorTransform;

          component1 = this.components[0];
          component2 = this.components[1];
          component3 = this.components[2];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
            component3Line = component3.lines[0 | (y * component3.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              if (!colorTransform) {
                R = component1Line[0 | (x * component1.scaleX * scaleX)];
                G = component2Line[0 | (x * component2.scaleX * scaleX)];
                B = component3Line[0 | (x * component3.scaleX * scaleX)];
              } else {
                Y = component1Line[0 | (x * component1.scaleX * scaleX)];
                Cb = component2Line[0 | (x * component2.scaleX * scaleX)];
                Cr = component3Line[0 | (x * component3.scaleX * scaleX)];

                R = clampTo8bit(Y + 1.402 * (Cr - 128));
                G = clampTo8bit(Y - 0.3441363 * (Cb - 128) - 0.71413636 * (Cr - 128));
                B = clampTo8bit(Y + 1.772 * (Cb - 128));
              }

              data[offset++] = R;
              data[offset++] = G;
              data[offset++] = B;
            }
          }
          break;
        case 4:
          if (!this.adobe)
            throw new Error('Unsupported color mode (4 components)');
          // The default transform for four components is false
          colorTransform = false;
          // The adobe transform marker overrides any previous setting
          if (this.adobe && this.adobe.transformCode)
            colorTransform = true;
          else if (typeof this.opts.colorTransform !== 'undefined')
            colorTransform = !!this.opts.colorTransform;

          component1 = this.components[0];
          component2 = this.components[1];
          component3 = this.components[2];
          component4 = this.components[3];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
            component3Line = component3.lines[0 | (y * component3.scaleY * scaleY)];
            component4Line = component4.lines[0 | (y * component4.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              if (!colorTransform) {
                C = component1Line[0 | (x * component1.scaleX * scaleX)];
                M = component2Line[0 | (x * component2.scaleX * scaleX)];
                Ye = component3Line[0 | (x * component3.scaleX * scaleX)];
                K = component4Line[0 | (x * component4.scaleX * scaleX)];
              } else {
                Y = component1Line[0 | (x * component1.scaleX * scaleX)];
                Cb = component2Line[0 | (x * component2.scaleX * scaleX)];
                Cr = component3Line[0 | (x * component3.scaleX * scaleX)];
                K = component4Line[0 | (x * component4.scaleX * scaleX)];

                C = 255 - clampTo8bit(Y + 1.402 * (Cr - 128));
                M = 255 - clampTo8bit(Y - 0.3441363 * (Cb - 128) - 0.71413636 * (Cr - 128));
                Ye = 255 - clampTo8bit(Y + 1.772 * (Cb - 128));
              }
              data[offset++] = 255-C;
              data[offset++] = 255-M;
              data[offset++] = 255-Ye;
              data[offset++] = 255-K;
            }
          }
          break;
        default:
          throw new Error('Unsupported color mode');
      }
      return data;
    },
    copyToImageData: function copyToImageData(imageData, formatAsRGBA) {
      var width = imageData.width, height = imageData.height;
      var imageDataArray = imageData.data;
      var data = this.getData(width, height);
      var i = 0, j = 0, x, y;
      var Y, K, C, M, R, G, B;
      switch (this.components.length) {
        case 1:
          for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
              Y = data[i++];

              imageDataArray[j++] = Y;
              imageDataArray[j++] = Y;
              imageDataArray[j++] = Y;
              if (formatAsRGBA) {
                imageDataArray[j++] = 255;
              }
            }
          }
          break;
        case 3:
          for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
              R = data[i++];
              G = data[i++];
              B = data[i++];

              imageDataArray[j++] = R;
              imageDataArray[j++] = G;
              imageDataArray[j++] = B;
              if (formatAsRGBA) {
                imageDataArray[j++] = 255;
              }
            }
          }
          break;
        case 4:
          for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
              C = data[i++];
              M = data[i++];
              Y = data[i++];
              K = data[i++];

              R = 255 - clampTo8bit(C * (1 - K / 255) + K);
              G = 255 - clampTo8bit(M * (1 - K / 255) + K);
              B = 255 - clampTo8bit(Y * (1 - K / 255) + K);

              imageDataArray[j++] = R;
              imageDataArray[j++] = G;
              imageDataArray[j++] = B;
              if (formatAsRGBA) {
                imageDataArray[j++] = 255;
              }
            }
          }
          break;
        default:
          throw new Error('Unsupported color mode');
      }
    }
  };


  // We cap the amount of memory used by jpeg-js to avoid unexpected OOMs from untrusted content.
  var totalBytesAllocated = 0;
  var maxMemoryUsageBytes = 0;
  function requestMemoryAllocation(increaseAmount = 0) {
    var totalMemoryImpactBytes = totalBytesAllocated + increaseAmount;
    if (totalMemoryImpactBytes > maxMemoryUsageBytes) {
      var exceededAmount = Math.ceil((totalMemoryImpactBytes - maxMemoryUsageBytes) / 1024 / 1024);
      throw new Error(`maxMemoryUsageInMB limit exceeded by at least ${exceededAmount}MB`);
    }

    totalBytesAllocated = totalMemoryImpactBytes;
  }

  constructor.resetMaxMemoryUsage = function (maxMemoryUsageBytes_) {
    totalBytesAllocated = 0;
    maxMemoryUsageBytes = maxMemoryUsageBytes_;
  };

  constructor.getBytesAllocated = function () {
    return totalBytesAllocated;
  };

  constructor.requestMemoryAllocation = requestMemoryAllocation;

  return constructor;
})();

if (typeof module !== 'undefined') {
	module.exports = decode;
} else if (typeof window !== 'undefined') {
	window['jpeg-js'] = window['jpeg-js'] || {};
	window['jpeg-js'].decode = decode;
}

function decode(jpegData, userOpts = {}) {
  var defaultOpts = {
    // "undefined" means "Choose whether to transform colors based on the image’s color model."
    colorTransform: undefined,
    useTArray: false,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: 100, // Don't decode more than 100 megapixels
    maxMemoryUsageInMB: 512, // Don't decode if memory footprint is more than 512MB
  };

  var opts = {...defaultOpts, ...userOpts};
  var arr = new Uint8Array(jpegData);
  var decoder = new JpegImage();
  decoder.opts = opts;
  // If this constructor ever supports async decoding this will need to be done differently.
  // Until then, treating as singleton limit is fine.
  JpegImage.resetMaxMemoryUsage(opts.maxMemoryUsageInMB * 1024 * 1024);
  decoder.parse(arr);

  var channels = (opts.formatAsRGBA) ? 4 : 3;
  var bytesNeeded = decoder.width * decoder.height * channels;
  try {
    JpegImage.requestMemoryAllocation(bytesNeeded);
    var image = {
      width: decoder.width,
      height: decoder.height,
      exifBuffer: decoder.exifBuffer,
      data: opts.useTArray ?
        new Uint8Array(bytesNeeded) :
        Buffer.alloc(bytesNeeded)
    };
    if(decoder.comments.length > 0) {
      image["comments"] = decoder.comments;
    }
  } catch (err) {
    if (err instanceof RangeError) {
      throw new Error("Could not allocate enough memory for the image. " +
                      "Required: " + bytesNeeded);
    } 
    
    if (err instanceof ReferenceError) {
      if (err.message === "Buffer is not defined") {
        throw new Error("Buffer is not globally defined in this environment. " +
                        "Consider setting useTArray to true");
      }
    }
    throw err;
  }

  decoder.copyToImageData(image, opts.formatAsRGBA);

  return image;
}
    return { decode: decode };
})();


// --- 2. UPNG.js ---
// The full source code of UPNG.js goes here.
// e.g., from https://raw.githubusercontent.com/photopea/UPNG.js/master/UPNG.js
// It depends on `pako.js` which should be loaded first and will create a global `UPNG` object.


var UPNG = (function() {
	
	var _bin = {
		nextZero   : function(data,p)  {  while(data[p]!=0) p++;  return p;  },
		readUshort : function(buff,p)  {  return (buff[p]<< 8) | buff[p+1];  },
		writeUshort: function(buff,p,n){  buff[p] = (n>>8)&255;  buff[p+1] = n&255;  },
		readUint   : function(buff,p)  {  return (buff[p]*(256*256*256)) + ((buff[p+1]<<16) | (buff[p+2]<< 8) | buff[p+3]);  },
		writeUint  : function(buff,p,n){  buff[p]=(n>>24)&255;  buff[p+1]=(n>>16)&255;  buff[p+2]=(n>>8)&255;  buff[p+3]=n&255;  },
		readASCII  : function(buff,p,l){  var s = "";  for(var i=0; i<l; i++) s += String.fromCharCode(buff[p+i]);  return s;    },
		writeASCII : function(data,p,s){  for(var i=0; i<s.length; i++) data[p+i] = s.charCodeAt(i);  },
		readBytes  : function(buff,p,l){  var arr = [];   for(var i=0; i<l; i++) arr.push(buff[p+i]);   return arr;  },
		pad : function(n) { return n.length < 2 ? "0" + n : n; },
		readUTF8 : function(buff, p, l) {
			var s = "", ns;
			for(var i=0; i<l; i++) s += "%" + _bin.pad(buff[p+i].toString(16));
			try {  ns = decodeURIComponent(s); }
			catch(e) {  return _bin.readASCII(buff, p, l);  }
			return  ns;
		}
	}

	function toRGBA8(out)
	{
		var w = out.width, h = out.height;
		if(out.tabs.acTL==null) return [decodeImage(out.data, w, h, out).buffer];
		
		var frms = [];
		if(out.frames[0].data==null) out.frames[0].data = out.data;
		
		var len = w*h*4, img = new Uint8Array(len), empty = new Uint8Array(len), prev=new Uint8Array(len);
		for(var i=0; i<out.frames.length; i++)
		{
			var frm = out.frames[i];
			var fx=frm.rect.x, fy=frm.rect.y, fw = frm.rect.width, fh = frm.rect.height;
			var fdata = decodeImage(frm.data, fw,fh, out);
			
			if(i!=0) for(var j=0; j<len; j++) prev[j]=img[j];
			
			if     (frm.blend==0) _copyTile(fdata, fw, fh, img, w, h, fx, fy, 0);
			else if(frm.blend==1) _copyTile(fdata, fw, fh, img, w, h, fx, fy, 1);
			
			frms.push(img.buffer.slice(0));
			
			if     (frm.dispose==0) {}
			else if(frm.dispose==1) _copyTile(empty, fw, fh, img, w, h, fx, fy, 0);
			else if(frm.dispose==2) for(var j=0; j<len; j++) img[j]=prev[j];
		}
		return frms;
	}
	function decodeImage(data, w, h, out)
	{
		var area = w*h, bpp = _getBPP(out);
		var bpl = Math.ceil(w*bpp/8);	// bytes per line

		var bf = new Uint8Array(area*4), bf32 = new Uint32Array(bf.buffer);
		var ctype = out.ctype, depth = out.depth;
		var rs = _bin.readUshort;
		
		//console.log(ctype, depth);
		var time = Date.now();

		if     (ctype==6) { // RGB + alpha
			var qarea = area<<2;
			if(depth== 8) for(var i=0; i<qarea;i+=4) {  bf[i] = data[i];  bf[i+1] = data[i+1];  bf[i+2] = data[i+2];  bf[i+3] = data[i+3]; }
			if(depth==16) for(var i=0; i<qarea;i++ ) {  bf[i] = data[i<<1];  }
		}
		else if(ctype==2) {	// RGB
			var ts=out.tabs["tRNS"];
			if(ts==null) {
				if(depth== 8) for(var i=0; i<area; i++) {  var ti=i*3;  bf32[i] = (255<<24)|(data[ti+2]<<16)|(data[ti+1]<<8)|data[ti];  }
				if(depth==16) for(var i=0; i<area; i++) {  var ti=i*6;  bf32[i] = (255<<24)|(data[ti+4]<<16)|(data[ti+2]<<8)|data[ti];  }
			}
			else {  var tr=ts[0], tg=ts[1], tb=ts[2];
				if(depth== 8) for(var i=0; i<area; i++) {  var qi=i<<2, ti=i*3;  bf32[i] = (255<<24)|(data[ti+2]<<16)|(data[ti+1]<<8)|data[ti];
					if(data[ti]   ==tr && data[ti+1]   ==tg && data[ti+2]   ==tb) bf[qi+3] = 0;  }
				if(depth==16) for(var i=0; i<area; i++) {  var qi=i<<2, ti=i*6;  bf32[i] = (255<<24)|(data[ti+4]<<16)|(data[ti+2]<<8)|data[ti];
					if(rs(data,ti)==tr && rs(data,ti+2)==tg && rs(data,ti+4)==tb) bf[qi+3] = 0;  }
			}
		}
		else if(ctype==3) {	// palette
			var p=out.tabs["PLTE"], ap=out.tabs["tRNS"], tl=ap?ap.length:0;
			//console.log(p, ap);
			if(depth==1) for(var y=0; y<h; y++) {  var s0 = y*bpl, t0 = y*w;
				for(var i=0; i<w; i++) { var qi=(t0+i)<<2, j=((data[s0+(i>>3)]>>(7-((i&7)<<0)))& 1), cj=3*j;  bf[qi]=p[cj];  bf[qi+1]=p[cj+1];  bf[qi+2]=p[cj+2];  bf[qi+3]=(j<tl)?ap[j]:255;  }
			}
			if(depth==2) for(var y=0; y<h; y++) {  var s0 = y*bpl, t0 = y*w;
				for(var i=0; i<w; i++) { var qi=(t0+i)<<2, j=((data[s0+(i>>2)]>>(6-((i&3)<<1)))& 3), cj=3*j;  bf[qi]=p[cj];  bf[qi+1]=p[cj+1];  bf[qi+2]=p[cj+2];  bf[qi+3]=(j<tl)?ap[j]:255;  }
			}
			if(depth==4) for(var y=0; y<h; y++) {  var s0 = y*bpl, t0 = y*w;
				for(var i=0; i<w; i++) { var qi=(t0+i)<<2, j=((data[s0+(i>>1)]>>(4-((i&1)<<2)))&15), cj=3*j;  bf[qi]=p[cj];  bf[qi+1]=p[cj+1];  bf[qi+2]=p[cj+2];  bf[qi+3]=(j<tl)?ap[j]:255;  }
			}
			if(depth==8) for(var i=0; i<area; i++ ) {  var qi=i<<2, j=data[i]                      , cj=3*j;  bf[qi]=p[cj];  bf[qi+1]=p[cj+1];  bf[qi+2]=p[cj+2];  bf[qi+3]=(j<tl)?ap[j]:255;  }
		}
		else if(ctype==4) {	// gray + alpha
			if(depth== 8)  for(var i=0; i<area; i++) {  var qi=i<<2, di=i<<1, gr=data[di];  bf[qi]=gr;  bf[qi+1]=gr;  bf[qi+2]=gr;  bf[qi+3]=data[di+1];  }
			if(depth==16)  for(var i=0; i<area; i++) {  var qi=i<<2, di=i<<2, gr=data[di];  bf[qi]=gr;  bf[qi+1]=gr;  bf[qi+2]=gr;  bf[qi+3]=data[di+2];  }
		}
		else if(ctype==0) {	// gray
			var tr = out.tabs["tRNS"] ? out.tabs["tRNS"] : -1;
			for(var y=0; y<h; y++) {
				var off = y*bpl, to = y*w;
				if     (depth== 1) for(var x=0; x<w; x++) {  var gr=255*((data[off+(x>>>3)]>>>(7 -((x&7)   )))& 1), al=(gr==tr*255)?0:255;  bf32[to+x]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
				else if(depth== 2) for(var x=0; x<w; x++) {  var gr= 85*((data[off+(x>>>2)]>>>(6 -((x&3)<<1)))& 3), al=(gr==tr* 85)?0:255;  bf32[to+x]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
				else if(depth== 4) for(var x=0; x<w; x++) {  var gr= 17*((data[off+(x>>>1)]>>>(4 -((x&1)<<2)))&15), al=(gr==tr* 17)?0:255;  bf32[to+x]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
				else if(depth== 8) for(var x=0; x<w; x++) {  var gr=data[off+     x], al=(gr                 ==tr)?0:255;  bf32[to+x]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
				else if(depth==16) for(var x=0; x<w; x++) {  var gr=data[off+(x<<1)], al=(rs(data,off+(x<<1))==tr)?0:255;  bf32[to+x]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
			}
		}
		//console.log(Date.now()-time);
		return bf;
	}



	function decode(buff)
	{
		var data = new Uint8Array(buff), offset = 8, bin = _bin, rUs = bin.readUshort, rUi = bin.readUint;
		var out = {tabs:{}, frames:[]};
		var dd = new Uint8Array(data.length), doff = 0;	 // put all IDAT data into it
		var fd, foff = 0;	// frames
		
		var mgck = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		for(var i=0; i<8; i++) if(data[i]!=mgck[i]) throw "The input is not a PNG file!";

		while(offset<data.length)
		{
			var len  = bin.readUint(data, offset);  offset += 4;
			var type = bin.readASCII(data, offset, 4);  offset += 4;
			//console.log(type,len);
			
			if     (type=="IHDR")  {  _IHDR(data, offset, out);  }
			else if(type=="iCCP")  {
				var off = offset;  while(data[off]!=0) off++;
				var nam = bin.readASCII(data,offset,off-offset);
				var cpr = data[off+1];
				var fil = data.slice(off+2,offset+len);
				var res = null;
				try { res = _inflate(fil); } catch(e) {  res = inflateRaw(fil);  }
				out.tabs[type] = res;
			}
			else if(type=="CgBI")  {  out.tabs[type] = data.slice(offset,offset+4);  }
			else if(type=="IDAT") {
				for(var i=0; i<len; i++) dd[doff+i] = data[offset+i];
				doff += len;
			}
			else if(type=="acTL")  {
				out.tabs[type] = {  num_frames:rUi(data, offset), num_plays:rUi(data, offset+4)  };
				fd = new Uint8Array(data.length);
			}
			else if(type=="fcTL")  {
				if(foff!=0) {  var fr = out.frames[out.frames.length-1];
					fr.data = _decompress(out, fd.slice(0,foff), fr.rect.width, fr.rect.height);  foff=0;
				}
				var rct = {x:rUi(data, offset+12),y:rUi(data, offset+16),width:rUi(data, offset+4),height:rUi(data, offset+8)};
				var del = rUs(data, offset+22);  del = rUs(data, offset+20) / (del==0?100:del);
				var frm = {rect:rct, delay:Math.round(del*1000), dispose:data[offset+24], blend:data[offset+25]};
				//console.log(frm);
				out.frames.push(frm);
			}
			else if(type=="fdAT") {
				for(var i=0; i<len-4; i++) fd[foff+i] = data[offset+i+4];
				foff += len-4;
			}
			else if(type=="pHYs") {
				out.tabs[type] = [bin.readUint(data, offset), bin.readUint(data, offset+4), data[offset+8]];
			}
			else if(type=="cHRM") {
				out.tabs[type] = [];
				for(var i=0; i<8; i++) out.tabs[type].push(bin.readUint(data, offset+i*4));
			}
			else if(type=="tEXt" || type=="zTXt") {
				if(out.tabs[type]==null) out.tabs[type] = {};
				var nz = bin.nextZero(data, offset);
				var keyw = bin.readASCII(data, offset, nz-offset);
				var text, tl=offset+len-nz-1;
				if(type=="tEXt") text = bin.readASCII(data, nz+1, tl);
				else {
					var bfr = _inflate(data.slice(nz+2,nz+2+tl));
					text = bin.readUTF8(bfr,0,bfr.length);
				}
				out.tabs[type][keyw] = text;
			}
			else if(type=="iTXt") {
				if(out.tabs[type]==null) out.tabs[type] = {};
				var nz = 0, off = offset;
				nz = bin.nextZero(data, off);
				var keyw = bin.readASCII(data, off, nz-off);  off = nz + 1;
				var cflag = data[off], cmeth = data[off+1];  off+=2;
				nz = bin.nextZero(data, off);
				var ltag = bin.readASCII(data, off, nz-off);  off = nz + 1;
				nz = bin.nextZero(data, off);
				var tkeyw = bin.readUTF8(data, off, nz-off);  off = nz + 1;
				var text, tl=len-(off-offset);
				if(cflag==0) text  = bin.readUTF8(data, off, tl);
				else {
					var bfr = _inflate(data.slice(off,off+tl));
					text = bin.readUTF8(bfr,0,bfr.length);
				}
				out.tabs[type][keyw] = text;
			}
			else if(type=="PLTE") {
				out.tabs[type] = bin.readBytes(data, offset, len);
			}
			else if(type=="hIST") {
				var pl = out.tabs["PLTE"].length/3;
				out.tabs[type] = [];  for(var i=0; i<pl; i++) out.tabs[type].push(rUs(data, offset+i*2));
			}
			else if(type=="tRNS") {
				if     (out.ctype==3) out.tabs[type] = bin.readBytes(data, offset, len);
				else if(out.ctype==0) out.tabs[type] = rUs(data, offset);
				else if(out.ctype==2) out.tabs[type] = [ rUs(data,offset),rUs(data,offset+2),rUs(data,offset+4) ];
				//else console.log("tRNS for unsupported color type",out.ctype, len);
			}
			else if(type=="gAMA") out.tabs[type] = bin.readUint(data, offset)/100000;
			else if(type=="sRGB") out.tabs[type] = data[offset];
			else if(type=="bKGD")
			{
				if     (out.ctype==0 || out.ctype==4) out.tabs[type] = [rUs(data, offset)];
				else if(out.ctype==2 || out.ctype==6) out.tabs[type] = [rUs(data, offset), rUs(data, offset+2), rUs(data, offset+4)];
				else if(out.ctype==3) out.tabs[type] = data[offset];
			}
			else if(type=="IEND") {
				break;
			}
			//else {  console.log("unknown chunk type", type, len);  out.tabs[type]=data.slice(offset,offset+len);  }
			offset += len;
			var crc = bin.readUint(data, offset);  offset += 4;
		}
		if(foff!=0) {  var fr = out.frames[out.frames.length-1];
			fr.data = _decompress(out, fd.slice(0,foff), fr.rect.width, fr.rect.height);
		}	
		out.data = _decompress(out, dd, out.width, out.height);
		
		delete out.compress;  delete out.interlace;  delete out.filter;
		return out;
	}

	function _decompress(out, dd, w, h) {
		var time = Date.now();
		var bpp = _getBPP(out), bpl = Math.ceil(w*bpp/8), buff = new Uint8Array((bpl+1+out.interlace)*h);
		if(out.tabs["CgBI"]) dd = inflateRaw(dd,buff);
		else                 dd = _inflate(dd,buff);
		//console.log(dd.length, buff.length);
		//console.log(Date.now()-time);

		var time=Date.now();
		if     (out.interlace==0) dd = _filterZero(dd, out, 0, w, h);
		else if(out.interlace==1) dd = _readInterlace(dd, out);
		//console.log(Date.now()-time);
		return dd;
	}

	function _inflate(data, buff) {  var out=inflateRaw(new Uint8Array(data.buffer, 2,data.length-6),buff);  return out;  }
	
	var inflateRaw=function(){var D=function(){var o=Uint16Array,j=Uint32Array;return{m:new o(16),v:new o(16),
	d:[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15],o:[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258,999,999,999],
	z:[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,0,0,0],B:new o(32),
	p:[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,65535,65535],
	w:[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,0,0],h:new j(32),g:new o(512),s:[],A:new o(32),t:[],k:new o(32768),c:[],
	a:[],n:new o(32768),e:[],C:new o(512),b:[],i:new o(1<<15),r:new j(286),f:new j(30),l:new j(19),u:new j(15e3),q:new o(1<<16),j:new o(1<<15)}}();
function C(o,j){var I=o.length,A,r,i,y,G,f=D.v;for(var y=0;y<=j;y++)f[y]=0;for(y=1;y<I;y+=2)f[o[y]]++;
var a=D.m;A=0;f[0]=0;for(r=1;r<=j;r++){A=A+f[r-1]<<1;a[r]=A}for(i=0;i<I;i+=2){G=o[i+1];if(G!=0){o[i]=a[G];
a[G]++}}}function t(o,j,I){var A=o.length,r=D.i;for(var i=0;i<A;i+=2)if(o[i+1]!=0){var y=i>>1,G=o[i+1],f=y<<4|G,a=j-G,k=o[i]<<a,N=k+(1<<a);
while(k!=N){var x=r[k]>>>15-j;I[x]=f;k++}}}function g(o,j){var I=D.i,A=15-j;for(var r=0;r<o.length;r+=2){var i=o[r]<<j-o[r+1];
o[r]=I[i]>>>A}}(function(){var o=1<<15;for(var j=0;j<o;j++){var I=j;I=(I&2863311530)>>>1|(I&1431655765)<<1;
I=(I&3435973836)>>>2|(I&858993459)<<2;I=(I&4042322160)>>>4|(I&252645135)<<4;I=(I&4278255360)>>>8|(I&16711935)<<8;
D.i[j]=(I>>>16|I<<16)>>>17}function A(r,i,y){while(i--!=0)r.push(0,y)}for(var j=0;j<32;j++){D.B[j]=D.o[j]<<3|D.z[j];
D.h[j]=D.p[j]<<4|D.w[j]}A(D.s,144,8);A(D.s,255-143,9);A(D.s,279-255,7);A(D.s,287-279,8);C(D.s,9);t(D.s,9,D.g);
g(D.s,9);A(D.t,32,5);C(D.t,5);t(D.t,5,D.A);g(D.t,5);A(D.b,19,0);A(D.c,286,0);A(D.e,30,0);A(D.a,320,0)}());
function F(o,j,I){return(o[j>>>3]|o[(j>>>3)+1]<<8)>>>(j&7)&(1<<I)-1}function s(o,j,I){return(o[j>>>3]|o[(j>>>3)+1]<<8|o[(j>>>3)+2]<<16)>>>(j&7)&(1<<I)-1}
function w(o,j){return(o[j>>>3]|o[(j>>>3)+1]<<8|o[(j>>>3)+2]<<16)>>>(j&7)}function b(o,j){return(o[j>>>3]|o[(j>>>3)+1]<<8|o[(j>>>3)+2]<<16|o[(j>>>3)+3]<<24)>>>(j&7)}
function v(o,j){var I=Uint8Array,r=0,i=0,y=0,G=0,f=0,a=0,k=0,N=0,x=0,P,J;
if(o[0]==3&&o[1]==0)return j?j:new I(0);var A=j==null;if(A)j=new I(o.length>>>2<<3);while(r==0){r=s(o,x,1);
i=s(o,x+1,2);x+=3;if(i==0){if((x&7)!=0)x+=8-(x&7);var K=(x>>>3)+4,m=o[K-4]|o[K-3]<<8;if(A)j=H(j,N+m);
j.set(new I(o.buffer,o.byteOffset+K,m),N);x=K+m<<3;N+=m;continue}if(A)j=H(j,N+(1<<17));if(i==1){P=D.g;
J=D.A;a=(1<<9)-1;k=(1<<5)-1}if(i==2){y=F(o,x,5)+257;G=F(o,x+5,5)+1;f=F(o,x+10,4)+4;x+=14;var O=x,Q=1;
for(var p=0;p<38;p+=2){D.b[p]=0;D.b[p+1]=0}for(var p=0;p<f;p++){var l=F(o,x+p*3,3);D.b[(D.d[p]<<1)+1]=l;
if(l>Q)Q=l}x+=3*f;C(D.b,Q);t(D.b,Q,D.C);P=D.k;J=D.n;x=B(D.C,(1<<Q)-1,y+G,o,x,D.a);var u=d(D.a,0,y,D.c);
a=(1<<u)-1;var n=d(D.a,y,G,D.e);k=(1<<n)-1;C(D.c,u);t(D.c,u,P);C(D.e,n);t(D.e,n,J)}while(!0){var h=P[w(o,x)&a];
x+=h&15;var L=h>>>4;if(L>>>8==0){j[N++]=L}else if(L==256){break}else{var M=N+L-254;if(L>264){var z=D.B[L-257];
M=N+(z>>>3)+F(o,x,z&7);x+=z&7}var e=J[w(o,x)&k];x+=e&15;var E=e>>>4,c=D.h[E],q=(c>>>4)+s(o,x,c&15);x+=c&15;
if(A)j=H(j,N+(1<<17));while(N<M){j[N]=j[N++-q];j[N]=j[N++-q];j[N]=j[N++-q];j[N]=j[N++-q]}N=M}}}return j.length==N?j:j.slice(0,N)}function H(o,j){var I=o.length;
if(j<=I)return o;var A=new Uint8Array(Math.max(I<<1,j));A.set(o,0);return A}function B(o,j,I,A,r,i){var y=0;
while(y<I){var G=o[w(A,r)&j];r+=G&15;var f=G>>>4;if(f<=15){i[y]=f;y++}else{var a=0,k=0;if(f==16){k=3+F(A,r,2);
r+=2;a=i[y-1]}else if(f==17){k=3+F(A,r,3);r+=3}else if(f==18){k=11+F(A,r,7);r+=7}var N=y+k;while(y<N){i[y]=a;
y++}}}return r}function d(o,j,I,A){var r=0,i=0,y=A.length>>>1;while(i<I){var G=o[i+j];A[i<<1]=0;A[(i<<1)+1]=G;
if(G>r)r=G;i++}while(i<y){A[i<<1]=0;A[(i<<1)+1]=0;i++}return r}return v}();


	function _readInterlace(data, out)
	{
		var w = out.width, h = out.height;
		var bpp = _getBPP(out), cbpp = bpp>>3, bpl = Math.ceil(w*bpp/8);
		var img = new Uint8Array( h * bpl );
		var di = 0;

		var starting_row  = [ 0, 0, 4, 0, 2, 0, 1 ];
		var starting_col  = [ 0, 4, 0, 2, 0, 1, 0 ];
		var row_increment = [ 8, 8, 8, 4, 4, 2, 2 ];
		var col_increment = [ 8, 8, 4, 4, 2, 2, 1 ];

		var pass=0;
		while(pass<7)
		{
			var ri = row_increment[pass], ci = col_increment[pass];
			var sw = 0, sh = 0;
			var cr = starting_row[pass];  while(cr<h) {  cr+=ri;  sh++;  }
			var cc = starting_col[pass];  while(cc<w) {  cc+=ci;  sw++;  }
			var bpll = Math.ceil(sw*bpp/8);
			_filterZero(data, out, di, sw, sh);

			var y=0, row = starting_row[pass];
			while(row<h)
			{
				var col = starting_col[pass];
				var cdi = (di+y*bpll)<<3;

				while(col<w)
				{
					if(bpp==1) {
						var val = data[cdi>>3];  val = (val>>(7-(cdi&7)))&1;
						img[row*bpl + (col>>3)] |= (val << (7-((col&7)<<0)));
					}
					if(bpp==2) {
						var val = data[cdi>>3];  val = (val>>(6-(cdi&7)))&3;
						img[row*bpl + (col>>2)] |= (val << (6-((col&3)<<1)));
					}
					if(bpp==4) {
						var val = data[cdi>>3];  val = (val>>(4-(cdi&7)))&15;
						img[row*bpl + (col>>1)] |= (val << (4-((col&1)<<2)));
					}
					if(bpp>=8) {
						var ii = row*bpl+col*cbpp;
						for(var j=0; j<cbpp; j++) img[ii+j] = data[(cdi>>3)+j];
					}
					cdi+=bpp;  col+=ci;
				}
				y++;  row += ri;
			}
			if(sw*sh!=0) di += sh * (1 + bpll);
			pass = pass + 1;
		}
		return img;
	}

	function _getBPP(out) {
		var noc = [1,null,3,1,2,null,4][out.ctype];
		return noc * out.depth;
	}

	function _filterZero(data, out, off, w, h)
	{
		var bpp = _getBPP(out), bpl = Math.ceil(w*bpp/8);
		bpp = Math.ceil(bpp/8);
		
		var i,di, type=data[off], x=0;
		
		if(type>1) data[off]=[0,0,1][type-2];  
		if(type==3) for(x=bpp; x<bpl; x++) data[x+1] = (data[x+1] + (data[x+1-bpp]>>>1) )&255;

		for(var y=0; y<h; y++)  {
			i = off+y*bpl; di = i+y+1;
			type = data[di-1]; x=0;

			if     (type==0)   for(; x<bpl; x++) data[i+x] = data[di+x];
			else if(type==1) { for(; x<bpp; x++) data[i+x] = data[di+x];
							   for(; x<bpl; x++) data[i+x] = (data[di+x] + data[i+x-bpp]);  }
			else if(type==2) { for(; x<bpl; x++) data[i+x] = (data[di+x] + data[i+x-bpl]);  }
			else if(type==3) { for(; x<bpp; x++) data[i+x] = (data[di+x] + ( data[i+x-bpl]>>>1));
							   for(; x<bpl; x++) data[i+x] = (data[di+x] + ((data[i+x-bpl]+data[i+x-bpp])>>>1) );  }
			else             { for(; x<bpp; x++) data[i+x] = (data[di+x] + _paeth(0, data[i+x-bpl], 0));
							   for(; x<bpl; x++) data[i+x] = (data[di+x] + _paeth(data[i+x-bpp], data[i+x-bpl], data[i+x-bpp-bpl]) );  }
		}
		return data;
	}

	function _paeth(a,b,c)
	{
		var p = a+b-c, pa = (p-a), pb = (p-b), pc = (p-c);
		if (pa*pa <= pb*pb && pa*pa <= pc*pc)  return a;
		else if (pb*pb <= pc*pc)  return b;
		return c;
	}

	function _IHDR(data, offset, out)
	{
		out.width  = _bin.readUint(data, offset);  offset += 4;
		out.height = _bin.readUint(data, offset);  offset += 4;
		out.depth     = data[offset];  offset++;
		out.ctype     = data[offset];  offset++;
		out.compress  = data[offset];  offset++;
		out.filter    = data[offset];  offset++;
		out.interlace = data[offset];  offset++;
	}

	function _copyTile(sb, sw, sh, tb, tw, th, xoff, yoff, mode)
	{
		var w = Math.min(sw,tw), h = Math.min(sh,th);
		var si=0, ti=0;
		for(var y=0; y<h; y++)
			for(var x=0; x<w; x++)
			{
				if(xoff>=0 && yoff>=0) {  si = (y*sw+x)<<2;  ti = (( yoff+y)*tw+xoff+x)<<2;  }
				else                   {  si = ((-yoff+y)*sw-xoff+x)<<2;  ti = (y*tw+x)<<2;  }
				
				if     (mode==0) {  tb[ti] = sb[si];  tb[ti+1] = sb[si+1];  tb[ti+2] = sb[si+2];  tb[ti+3] = sb[si+3];  }
				else if(mode==1) {
					var fa = sb[si+3]*(1/255), fr=sb[si]*fa, fg=sb[si+1]*fa, fb=sb[si+2]*fa; 
					var ba = tb[ti+3]*(1/255), br=tb[ti]*ba, bg=tb[ti+1]*ba, bb=tb[ti+2]*ba; 
					
					var ifa=1-fa, oa = fa+ba*ifa, ioa = (oa==0?0:1/oa);
					tb[ti+3] = 255*oa;  
					tb[ti+0] = (fr+br*ifa)*ioa;  
					tb[ti+1] = (fg+bg*ifa)*ioa;   
					tb[ti+2] = (fb+bb*ifa)*ioa;  
				}
				else if(mode==2){	// copy only differences, otherwise zero
					var fa = sb[si+3], fr=sb[si], fg=sb[si+1], fb=sb[si+2]; 
					var ba = tb[ti+3], br=tb[ti], bg=tb[ti+1], bb=tb[ti+2]; 
					if(fa==ba && fr==br && fg==bg && fb==bb) {  tb[ti]=0;  tb[ti+1]=0;  tb[ti+2]=0;  tb[ti+3]=0;  }
					else {  tb[ti]=fr;  tb[ti+1]=fg;  tb[ti+2]=fb;  tb[ti+3]=fa;  }
				}
				else if(mode==3){	// check if can be blended
					var fa = sb[si+3], fr=sb[si], fg=sb[si+1], fb=sb[si+2]; 
					var ba = tb[ti+3], br=tb[ti], bg=tb[ti+1], bb=tb[ti+2]; 
					if(fa==ba && fr==br && fg==bg && fb==bb) continue;
					//if(fa!=255 && ba!=0) return false;
					if(fa<220 && ba>20) return false;
				}
			}
		return true;
	}
	
	return {
		decode:decode,
		toRGBA8:toRGBA8,
		_paeth:_paeth,
		_copyTile:_copyTile,
		_bin:_bin
	};

})();









(function() {
	var _copyTile = UPNG._copyTile, _bin=UPNG._bin, paeth = UPNG._paeth;
	var crcLib = {
		table : ( function() {
		   var tab = new Uint32Array(256);
		   for (var n=0; n<256; n++) {
				var c = n;
				for (var k=0; k<8; k++) {
					if (c & 1)  c = 0xedb88320 ^ (c >>> 1);
					else        c = c >>> 1;
				}
				tab[n] = c;  }
			return tab;  })(),
		update : function(c, buf, off, len) {
			for (var i=0; i<len; i++)  c = crcLib.table[(c ^ buf[off+i]) & 0xff] ^ (c >>> 8);
			return c;
		},
		crc : function(b,o,l)  {  return crcLib.update(0xffffffff,b,o,l) ^ 0xffffffff;  }
	}
	
	
	function addErr(er, tg, ti, f) {
		tg[ti]+=(er[0]*f)>>4;  tg[ti+1]+=(er[1]*f)>>4;  tg[ti+2]+=(er[2]*f)>>4;  tg[ti+3]+=(er[3]*f)>>4;  
	}
	function N(x) {  return Math.max(0, Math.min(255, x));  }
	function D(a,b) {  var dr=a[0]-b[0], dg=a[1]-b[1], db=a[2]-b[2], da=a[3]-b[3];  return (dr*dr + dg*dg + db*db + da*da);  }
		
	// MTD: 0: None, 1: floyd-steinberg, 2: Bayer
	function dither(sb, w, h, plte, tb, oind, MTD) {
		if(MTD==null) MTD=1;		
		
		var pc=plte.length, nplt = [], rads=[];
		for(var i=0; i<pc; i++) {
			var c = plte[i];
			nplt.push([((c>>>0)&255), ((c>>>8)&255), ((c>>>16)&255), ((c>>>24)&255)]);
		}
		for(var i=0; i<pc; i++) {
			var ne=0xffffffff, ni=0;
			for(var j=0; j<pc; j++) {  var ce=D(nplt[i],nplt[j]);  if(j!=i && ce<ne) {  ne=ce;  ni=j;  }  }
			var hd = Math.sqrt(ne)/2;
			rads[i] = ~~(hd*hd);
		}
			
		var tb32 = new Uint32Array(tb.buffer);
		var err = new Int16Array(w*h*4);
		
		/*
		var S=2, M = [
			0,2,
		    3,1];  //*/
		//*
		var S=4, M = [
			 0, 8, 2,10,
		    12, 4,14, 6,
			 3,11, 1, 9,
			15, 7,13, 5 ];  //*/
		for(var i=0; i<M.length; i++) M[i] = 255*(-0.5 + (M[i]+0.5)/(S*S));
		
		for(var y=0; y<h; y++) {
			for(var x=0; x<w; x++) {
				var i = (y*w+x)*4;
				
				var cc;
				if(MTD!=2) cc = [N(sb[i]+err[i]), N(sb[i+1]+err[i+1]), N(sb[i+2]+err[i+2]), N(sb[i+3]+err[i+3])];
				else {
					var ce = M[(y&(S-1))*S+(x&(S-1))];
					cc = [N(sb[i]+ce), N(sb[i+1]+ce), N(sb[i+2]+ce), N(sb[i+3]+ce)];
				}
				
				var ni=0, nd = 0xffffff;
				for(var j=0; j<pc; j++) {
					var cd = D(cc,nplt[j]);
					if(cd<nd) {  nd=cd;  ni=j;  }
				}  
				
				var nc = nplt[ni];
				var er = [cc[0]-nc[0], cc[1]-nc[1], cc[2]-nc[2], cc[3]-nc[3]];
				
				if(MTD==1) {
					//addErr(er, err, i+4, 16);
					if(x!=w-1) addErr(er, err, i+4    , 7);
					if(y!=h-1) {
						if(x!=  0) addErr(er, err, i+4*w-4, 3);
								   addErr(er, err, i+4*w  , 5);
						if(x!=w-1) addErr(er, err, i+4*w+4, 1);  
					}//*/
				}
				oind[i>>2] = ni;  tb32[i>>2] = plte[ni];
			}
		}
	}

	
	function encode(bufs, w, h, ps, dels, tabs, forbidPlte)
	{
		if(ps==null) ps=0;
		if(forbidPlte==null) forbidPlte = false;

		var nimg = compress(bufs, w, h, ps, [false, false, false, 0, forbidPlte,false]);
		compressPNG(nimg, -1);
		
		return _main(nimg, w, h, dels, tabs);
	}

	function encodeLL(bufs, w, h, cc, ac, depth, dels, tabs) {
		var nimg = {  ctype: 0 + (cc==1 ? 0 : 2) + (ac==0 ? 0 : 4),      depth: depth,  frames: []  };
		
		var time = Date.now();
		var bipp = (cc+ac)*depth, bipl = bipp * w;
		for(var i=0; i<bufs.length; i++)
			nimg.frames.push({  rect:{x:0,y:0,width:w,height:h},  img:new Uint8Array(bufs[i]), blend:0, dispose:1, bpp:Math.ceil(bipp/8), bpl:Math.ceil(bipl/8)  });
		
		compressPNG(nimg, 0, true);
		
		var out = _main(nimg, w, h, dels, tabs);
		return out;
	}

	function _main(nimg, w, h, dels, tabs) {
		if(tabs==null) tabs={};
		var crc = crcLib.crc, wUi = _bin.writeUint, wUs = _bin.writeUshort, wAs = _bin.writeASCII;
		var offset = 8, anim = nimg.frames.length>1, pltAlpha = false;
		
		var cicc;
		
		var leng = 8 + (16+5+4) /*+ (9+4)*/ + (anim ? 20 : 0);
		if(tabs["sRGB"]!=null) leng += 8+1+4;
		if(tabs["pHYs"]!=null) leng += 8+9+4;
		if(tabs["iCCP"]!=null) {  cicc = pako.deflate(tabs["iCCP"]);  leng += 8 + 11 + 2 + cicc.length + 4;  }
		if(nimg.ctype==3) {
			var dl = nimg.plte.length;
			for(var i=0; i<dl; i++) if((nimg.plte[i]>>>24)!=255) pltAlpha = true;
			leng += (8 + dl*3 + 4) + (pltAlpha ? (8 + dl*1 + 4) : 0);
		}
		for(var j=0; j<nimg.frames.length; j++)
		{
			var fr = nimg.frames[j];
			if(anim) leng += 38;
			leng += fr.cimg.length + 12;
			if(j!=0) leng+=4;
		}
		leng += 12; 
		
		var data = new Uint8Array(leng);
		var wr=[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		for(var i=0; i<8; i++) data[i]=wr[i];
		
		wUi(data,offset, 13);     offset+=4;
		wAs(data,offset,"IHDR");  offset+=4;
		wUi(data,offset,w);  offset+=4;
		wUi(data,offset,h);  offset+=4;
		data[offset] = nimg.depth;  offset++;  // depth
		data[offset] = nimg.ctype;  offset++;  // ctype
		data[offset] = 0;  offset++;  // compress
		data[offset] = 0;  offset++;  // filter
		data[offset] = 0;  offset++;  // interlace
		wUi(data,offset,crc(data,offset-17,17));  offset+=4; // crc

		// 13 bytes to say, that it is sRGB
		if(tabs["sRGB"]!=null) {
			wUi(data,offset, 1);      offset+=4;
			wAs(data,offset,"sRGB");  offset+=4;
			data[offset] = tabs["sRGB"];  offset++;
			wUi(data,offset,crc(data,offset-5,5));  offset+=4; // crc
		}
		if(tabs["iCCP"]!=null) {
			var sl = 11+2+cicc.length;
			wUi(data,offset, sl);  offset+=4;
			wAs(data,offset,"iCCP");  offset+=4;
			wAs(data,offset,"ICC profile");  offset+=11;  offset+=2;
			data.set(cicc, offset);  offset+=cicc.length;
			wUi(data,offset,crc(data,offset-(sl+4),sl+4));  offset+=4; // crc
		}
		if(tabs["pHYs"]!=null) {
			wUi(data,offset, 9);      offset+=4;
			wAs(data,offset,"pHYs");  offset+=4;
			wUi(data,offset, tabs["pHYs"][0]);      offset+=4;
			wUi(data,offset, tabs["pHYs"][1]);      offset+=4;
			data[offset]=tabs["pHYs"][2];			offset++;
			wUi(data,offset,crc(data,offset-13,13));  offset+=4; // crc
		}

		if(anim) {
			wUi(data,offset, 8);      offset+=4;
			wAs(data,offset,"acTL");  offset+=4;
			wUi(data,offset, nimg.frames.length);     offset+=4;
			wUi(data,offset, tabs["loop"]!=null?tabs["loop"]:0);      offset+=4;
			wUi(data,offset,crc(data,offset-12,12));  offset+=4; // crc
		}

		if(nimg.ctype==3) {
			var dl = nimg.plte.length;
			wUi(data,offset, dl*3);  offset+=4;
			wAs(data,offset,"PLTE");  offset+=4;
			for(var i=0; i<dl; i++){
				var ti=i*3, c=nimg.plte[i], r=(c)&255, g=(c>>>8)&255, b=(c>>>16)&255;
				data[offset+ti+0]=r;  data[offset+ti+1]=g;  data[offset+ti+2]=b;
			}
			offset+=dl*3;
			wUi(data,offset,crc(data,offset-dl*3-4,dl*3+4));  offset+=4; // crc

			if(pltAlpha) {
				wUi(data,offset, dl);  offset+=4;
				wAs(data,offset,"tRNS");  offset+=4;
				for(var i=0; i<dl; i++)  data[offset+i]=(nimg.plte[i]>>>24)&255;
				offset+=dl;
				wUi(data,offset,crc(data,offset-dl-4,dl+4));  offset+=4; // crc
			}
		}
		
		var fi = 0;
		for(var j=0; j<nimg.frames.length; j++)
		{
			var fr = nimg.frames[j];
			if(anim) {
				wUi(data, offset, 26);     offset+=4;
				wAs(data, offset,"fcTL");  offset+=4;
				wUi(data, offset, fi++);   offset+=4;
				wUi(data, offset, fr.rect.width );   offset+=4;
				wUi(data, offset, fr.rect.height);   offset+=4;
				wUi(data, offset, fr.rect.x);   offset+=4;
				wUi(data, offset, fr.rect.y);   offset+=4;
				wUs(data, offset, dels[j]);   offset+=2;
				wUs(data, offset,  1000);   offset+=2;
				data[offset] = fr.dispose;  offset++;	// dispose
				data[offset] = fr.blend  ;  offset++;	// blend
				wUi(data,offset,crc(data,offset-30,30));  offset+=4; // crc
			}
					
			var imgd = fr.cimg, dl = imgd.length;
			wUi(data,offset, dl+(j==0?0:4));     offset+=4;
			var ioff = offset;
			wAs(data,offset,(j==0)?"IDAT":"fdAT");  offset+=4;
			if(j!=0) {  wUi(data, offset, fi++);  offset+=4;  }
			data.set(imgd,offset);
			offset += dl;
			wUi(data,offset,crc(data,ioff,offset-ioff));  offset+=4; // crc
		}

		wUi(data,offset, 0);     offset+=4;
		wAs(data,offset,"IEND");  offset+=4;
		wUi(data,offset,crc(data,offset-4,4));  offset+=4; // crc

		return data.buffer;
	}

	function compressPNG(out, filter, levelZero) {
		for(var i=0; i<out.frames.length; i++) {
			var frm = out.frames[i], nw=frm.rect.width, nh=frm.rect.height;
			var fdata = new Uint8Array(nh*frm.bpl+nh);
			frm.cimg = _filterZero(frm.img,nh,frm.bpp,frm.bpl,fdata, filter, levelZero);
		}
	}



	function compress(bufs, w, h, ps, prms) // prms:  onlyBlend, minBits, forbidPlte
	{
		//var time = Date.now();
		var onlyBlend = prms[0], evenCrd = prms[1], forbidPrev = prms[2], minBits = prms[3], forbidPlte = prms[4], dith=prms[5];
		
		var ctype = 6, depth = 8, alphaAnd=255
		
		for(var j=0; j<bufs.length; j++)  {  // when not quantized, other frames can contain colors, that are not in an initial frame
			var img = new Uint8Array(bufs[j]), ilen = img.length;
			for(var i=0; i<ilen; i+=4) alphaAnd &= img[i+3];
		}
		var gotAlpha = (alphaAnd!=255);
		
		//console.log("alpha check", Date.now()-time);  time = Date.now();
		
		//var brute = gotAlpha && forGIF;		// brute : frames can only be copied, not "blended"
		var frms = framize(bufs, w, h, onlyBlend, evenCrd, forbidPrev);
		//console.log("framize", Date.now()-time);  time = Date.now();
		
		var cmap={}, plte=[], inds=[]; 
		
		if(ps!=0) {
			var nbufs = [];  for(var i=0; i<frms.length; i++) nbufs.push(frms[i].img.buffer);
			
			var abuf = concatRGBA(nbufs), qres = quantize(abuf, ps);
			
			for(var i=0; i<qres.plte.length; i++) plte.push(qres.plte[i].est.rgba);
			
			var cof = 0;
			for(var i=0; i<frms.length; i++) {  
				var frm=frms[i], bln=frm.img.length, ind = new Uint8Array(qres.inds.buffer, cof>>2, bln>>2);  inds.push(ind);
				var bb = new Uint8Array(qres.abuf,cof,bln);
				
				//console.log(frm.img, frm.width, frm.height);
				//var time = Date.now();
				if(dith) dither(frm.img, frm.rect.width, frm.rect.height, plte, bb, ind);
				//console.log(Date.now()-time);
				frm.img.set(bb);  cof+=bln;  
			}
			
			//console.log("quantize", Date.now()-time);  time = Date.now();
		}
		else {
			// what if ps==0, but there are <=256 colors?  we still need to detect, if the palette could be used
			for(var j=0; j<frms.length; j++)  {  // when not quantized, other frames can contain colors, that are not in an initial frame
				var frm = frms[j], img32 = new Uint32Array(frm.img.buffer), nw=frm.rect.width, ilen = img32.length;
				var ind = new Uint8Array(ilen);  inds.push(ind);
				for(var i=0; i<ilen; i++) {
					var c = img32[i];
					if     (i!=0 && c==img32[i- 1]) ind[i]=ind[i-1];
					else if(i>nw && c==img32[i-nw]) ind[i]=ind[i-nw];
					else {
						var cmc = cmap[c];
						if(cmc==null) {  cmap[c]=cmc=plte.length;  plte.push(c);  if(plte.length>=300) break;  }
						ind[i]=cmc;
					}
				}
			}
			//console.log("make palette", Date.now()-time);  time = Date.now();
		}
		
		var cc=plte.length; //console.log("colors:",cc);
		if(cc<=256 && forbidPlte==false) {
			if(cc<= 2) depth=1;  else if(cc<= 4) depth=2;  else if(cc<=16) depth=4;  else depth=8;
			depth =  Math.max(depth, minBits);
		}
		
		for(var j=0; j<frms.length; j++)
		{
			var frm = frms[j], nx=frm.rect.x, ny=frm.rect.y, nw=frm.rect.width, nh=frm.rect.height;
			var cimg = frm.img, cimg32 = new Uint32Array(cimg.buffer);
			var bpl = 4*nw, bpp=4;
			if(cc<=256 && forbidPlte==false) {
				bpl = Math.ceil(depth*nw/8);
				var nimg = new Uint8Array(bpl*nh);
				var inj = inds[j];
				for(var y=0; y<nh; y++) {  var i=y*bpl, ii=y*nw;
					if     (depth==8) for(var x=0; x<nw; x++) nimg[i+(x)   ]   =  (inj[ii+x]             );
					else if(depth==4) for(var x=0; x<nw; x++) nimg[i+(x>>1)]  |=  (inj[ii+x]<<(4-(x&1)*4));
					else if(depth==2) for(var x=0; x<nw; x++) nimg[i+(x>>2)]  |=  (inj[ii+x]<<(6-(x&3)*2));
					else if(depth==1) for(var x=0; x<nw; x++) nimg[i+(x>>3)]  |=  (inj[ii+x]<<(7-(x&7)*1));
				}
				cimg=nimg;  ctype=3;  bpp=1;
			}
			else if(gotAlpha==false && frms.length==1) {	// some next "reduced" frames may contain alpha for blending
				var nimg = new Uint8Array(nw*nh*3), area=nw*nh;
				for(var i=0; i<area; i++) { var ti=i*3, qi=i*4;  nimg[ti]=cimg[qi];  nimg[ti+1]=cimg[qi+1];  nimg[ti+2]=cimg[qi+2];  }
				cimg=nimg;  ctype=2;  bpp=3;  bpl=3*nw;
			}
			frm.img=cimg;  frm.bpl=bpl;  frm.bpp=bpp;
		}
		//console.log("colors => palette indices", Date.now()-time);  time = Date.now();
		
		return {ctype:ctype, depth:depth, plte:plte, frames:frms  };
	}
	function framize(bufs,w,h,alwaysBlend,evenCrd,forbidPrev) {
		/*  DISPOSE
			- 0 : no change
			- 1 : clear to transparent
			- 2 : retstore to content before rendering (previous frame disposed)
			BLEND
			- 0 : replace
			- 1 : blend
		*/
		var frms = [];
		for(var j=0; j<bufs.length; j++) {
			var cimg = new Uint8Array(bufs[j]), cimg32 = new Uint32Array(cimg.buffer);
			var nimg;
			
			var nx=0, ny=0, nw=w, nh=h, blend=alwaysBlend?1:0;
			if(j!=0) {
				var tlim = (forbidPrev || alwaysBlend || j==1 || frms[j-2].dispose!=0)?1:2, tstp = 0, tarea = 1e9;
				for(var it=0; it<tlim; it++)
				{
					var pimg = new Uint8Array(bufs[j-1-it]), p32 = new Uint32Array(bufs[j-1-it]);
					var mix=w,miy=h,max=-1,may=-1;
					for(var y=0; y<h; y++) for(var x=0; x<w; x++) {
						var i = y*w+x;
						if(cimg32[i]!=p32[i]) {
							if(x<mix) mix=x;  if(x>max) max=x;
							if(y<miy) miy=y;  if(y>may) may=y;
						}
					}
					if(max==-1) mix=miy=max=may=0;
					if(evenCrd) {  if((mix&1)==1)mix--;  if((miy&1)==1)miy--;  }
					var sarea = (max-mix+1)*(may-miy+1);
					if(sarea<tarea) {
						tarea = sarea;  tstp = it;
						nx = mix; ny = miy; nw = max-mix+1; nh = may-miy+1;
					}
				}
				
				// alwaysBlend: pokud zjistím, že blendit nelze, nastavím předchozímu snímku dispose=1. Zajistím, aby obsahoval můj obdélník.
				var pimg = new Uint8Array(bufs[j-1-tstp]);
				if(tstp==1) frms[j-1].dispose = 2;
				
				nimg = new Uint8Array(nw*nh*4);
				_copyTile(pimg,w,h, nimg,nw,nh, -nx,-ny, 0);
				
				blend =  _copyTile(cimg,w,h, nimg,nw,nh, -nx,-ny, 3) ? 1 : 0;
				if(blend==1) _prepareDiff(cimg,w,h,nimg,{x:nx,y:ny,width:nw,height:nh});
				else         _copyTile(cimg,w,h, nimg,nw,nh, -nx,-ny, 0);
			}
			else nimg = cimg.slice(0);	// img may be rewritten further ... don't rewrite input
			
			frms.push({rect:{x:nx,y:ny,width:nw,height:nh}, img:nimg, blend:blend, dispose:0});
		}
		
		
		if(alwaysBlend) for(var j=0; j<frms.length; j++) {
			var frm = frms[j];  if(frm.blend==1) continue;
			var r0 = frm.rect, r1 = frms[j-1].rect
			var miX = Math.min(r0.x, r1.x), miY = Math.min(r0.y, r1.y);
			var maX = Math.max(r0.x+r0.width, r1.x+r1.width), maY = Math.max(r0.y+r0.height, r1.y+r1.height);
			var r = {x:miX, y:miY, width:maX-miX, height:maY-miY};
			
			frms[j-1].dispose = 1;
			if(j-1!=0) 
			_updateFrame(bufs, w,h,frms, j-1,r, evenCrd);
			_updateFrame(bufs, w,h,frms, j  ,r, evenCrd);
		}
		var area = 0;
		if(bufs.length!=1) for(var i=0; i<frms.length; i++) {
			var frm = frms[i];
			area += frm.rect.width*frm.rect.height;
			//if(i==0 || frm.blend!=1) continue;
			//var ob = new Uint8Array(
			//console.log(frm.blend, frm.dispose, frm.rect);
		}
		//if(area!=0) console.log(area);
		return frms;
	}
	function _updateFrame(bufs, w,h, frms, i, r, evenCrd) {
		var U8 = Uint8Array, U32 = Uint32Array;
		var pimg = new U8(bufs[i-1]), pimg32 = new U32(bufs[i-1]), nimg = i+1<bufs.length ? new U8(bufs[i+1]):null;
		var cimg = new U8(bufs[i]), cimg32 = new U32(cimg.buffer);
		
		var mix=w,miy=h,max=-1,may=-1;
		for(var y=0; y<r.height; y++) for(var x=0; x<r.width; x++) {
			var cx = r.x+x, cy = r.y+y;
			var j = cy*w+cx, cc = cimg32[j];
			// no need to draw transparency, or to dispose it. Or, if writing the same color and the next one does not need transparency.
			if(cc==0 || (frms[i-1].dispose==0 && pimg32[j]==cc && (nimg==null || nimg[j*4+3]!=0))/**/) {}
			else {
				if(cx<mix) mix=cx;  if(cx>max) max=cx;
				if(cy<miy) miy=cy;  if(cy>may) may=cy;
			}
		}
		if(max==-1) mix=miy=max=may=0;
		if(evenCrd) {  if((mix&1)==1)mix--;  if((miy&1)==1)miy--;  }
		r = {x:mix, y:miy, width:max-mix+1, height:may-miy+1};
		
		var fr = frms[i];  fr.rect = r;  fr.blend = 1;  fr.img = new Uint8Array(r.width*r.height*4);
		if(frms[i-1].dispose==0) {
			_copyTile(pimg,w,h, fr.img,r.width,r.height, -r.x,-r.y, 0);
			_prepareDiff(cimg,w,h,fr.img,r);
		}
		else
			_copyTile(cimg,w,h, fr.img,r.width,r.height, -r.x,-r.y, 0);
	}
	function _prepareDiff(cimg, w,h, nimg, rec) {
		_copyTile(cimg,w,h, nimg,rec.width,rec.height, -rec.x,-rec.y, 2);
	}

	function _filterZero(img,h,bpp,bpl,data, filter, levelZero)
	{
		var fls = [], ftry=[0,1,2,3,4];
		if     (filter!=-1)             ftry=[filter];
		else if(h*bpl>500000 || bpp==1) ftry=[0];
		var opts;  if(levelZero) opts={level:0};
		
		
		var CMPR = (data.length>10e6 && window.UZIP!=null) ? window.UZIP : pako;
		
		var time = Date.now();
		for(var i=0; i<ftry.length; i++) {
			for(var y=0; y<h; y++) _filterLine(data, img, y, bpl, bpp, ftry[i]);
			//var nimg = new Uint8Array(data.length);
			//var sz = UZIP.F.deflate(data, nimg);  fls.push(nimg.slice(0,sz));
			//var dfl = pako["deflate"](data), dl=dfl.length-4;
			//var crc = (dfl[dl+3]<<24)|(dfl[dl+2]<<16)|(dfl[dl+1]<<8)|(dfl[dl+0]<<0);
			//console.log(crc, UZIP.adler(data,2,data.length-6));
			fls.push(CMPR["deflate"](data,opts));
		}
		
		var ti, tsize=1e9;
		for(var i=0; i<fls.length; i++) if(fls[i].length<tsize) {  ti=i;  tsize=fls[i].length;  }
		return fls[ti];
	}
	function _filterLine(data, img, y, bpl, bpp, type)
	{
		var i = y*bpl, di = i+y;
		data[di]=type;  di++;

		if(type==0) {
			if(bpl<500) for(var x=0; x<bpl; x++) data[di+x] = img[i+x];
			else data.set(new Uint8Array(img.buffer,i,bpl),di);
		}
		else if(type==1) {
			for(var x=  0; x<bpp; x++) data[di+x] =  img[i+x];
			for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x]-img[i+x-bpp]+256)&255;
		}
		else if(y==0) {
			for(var x=  0; x<bpp; x++) data[di+x] = img[i+x];

			if(type==2) for(var x=bpp; x<bpl; x++) data[di+x] = img[i+x];
			if(type==3) for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x] - (img[i+x-bpp]>>1) +256)&255;
			if(type==4) for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x] - paeth(img[i+x-bpp], 0, 0) +256)&255;
		}
		else {
			if(type==2) { for(var x=  0; x<bpl; x++) data[di+x] = (img[i+x]+256 - img[i+x-bpl])&255;  }
			if(type==3) { for(var x=  0; x<bpp; x++) data[di+x] = (img[i+x]+256 - (img[i+x-bpl]>>1))&255;
						  for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x]+256 - ((img[i+x-bpl]+img[i+x-bpp])>>1))&255;  }
			if(type==4) { for(var x=  0; x<bpp; x++) data[di+x] = (img[i+x]+256 - paeth(0, img[i+x-bpl], 0))&255;
						  for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x]+256 - paeth(img[i+x-bpp], img[i+x-bpl], img[i+x-bpp-bpl]))&255;  }
		}
	}


	function quantize(abuf, ps, doKmeans)
	{	
		var time = Date.now();
		var sb = new Uint8Array(abuf), tb = sb.slice(0), tb32 = new Uint32Array(tb.buffer);
		
		var KD = getKDtree(tb, ps);
		var root = KD[0], leafs = KD[1], K=leafs.length;
		
		//console.log(Date.now()-time, "tree made");  time = Date.now();
		
		var cl32 = new Uint32Array(K), clr8=new Uint8Array(cl32.buffer);
		for(var i=0; i<K; i++) cl32[i]=leafs[i].est.rgba;
		
		var len=sb.length;
			
		var inds = new Uint8Array(len>>2), nd;
		if(K<=60) {  findNearest(sb,inds,clr8);  remap(inds,tb32,cl32);  }
		else if(sb.length<32e6)  // precise, but slow :(
			//for(var j=0; j<4; j++) 
			for(var i=0; i<len; i+=4) {
				var r=sb[i]*(1/255), g=sb[i+1]*(1/255), b=sb[i+2]*(1/255), a=sb[i+3]*(1/255);
				
				nd = getNearest(root, r, g, b, a);
				inds[i>>2] = nd.ind;  tb32[i>>2] = nd.est.rgba;
			}
		else 
			for(var i=0; i<len; i+=4) {
				var r=sb[i]*(1/255), g=sb[i+1]*(1/255), b=sb[i+2]*(1/255), a=sb[i+3]*(1/255);
				
				nd = root;  while(nd.left) nd = (planeDst(nd.est,r,g,b,a)<=0) ? nd.left : nd.right;
				inds[i>>2] = nd.ind;  tb32[i>>2] = nd.est.rgba;
			}
			
		//console.log(Date.now()-time, "nearest found");  time = Date.now();
		
		if(doKmeans || sb.length*K<10*4e6) {
			var le = 1e9;
			for(var i=0; i<10; i++) {
				var ce = kmeans(sb, inds, clr8);  //console.log(i,ce);
				if(ce/le>0.997) break;  le=ce;
			}
			for(var i=0; i<K; i++) leafs[i].est.rgba = cl32[i];
			remap(inds,tb32,cl32);
			//console.log(Date.now()-time, "k-means");
		}
		
		return {  abuf:tb.buffer, inds:inds, plte:leafs  };
	}
	
	function remap(inds,tb32,pl32) {  for(var i=0; i<inds.length; i++) tb32[i]=pl32[inds[i]];  }
	function kmeans(sb,inds,plte) {
		updatePalette(sb,inds,plte);
		var err = findNearest(sb,inds,plte);
		return err;
	}
	
	function updatePalette(sb,inds,plte) {
		var K = plte.length>>>2;
		var sums = new Uint32Array(K*4), cnts = new Uint32Array(K);
		
		for(var i=0; i<sb.length; i+=4) {
			var ind = inds[i>>>2], qi=ind*4;
			cnts[ind]++;
			sums[qi  ]+=sb[i  ];  sums[qi+1]+=sb[i+1];
			sums[qi+2]+=sb[i+2];  sums[qi+3]+=sb[i+3];
		}
		for(var i=0; i<plte.length; i++) plte[i]=Math.round(sums[i]/cnts[i>>>2]);
	}
	
	function findNearest(sb,inds,plte) {
		var terr = 0, K=plte.length>>>2;
		
		var nd = [];  // squared half-distance to the nearest color
		for(var i=0; i<K; i++) {
			var qi=i*4;
			var r=plte[qi], g=plte[qi+1], b=plte[qi+2], a=plte[qi+3], ti=0, te=1e9;
			for(var j=0; j<K; j++) {
				if(i==j) continue;
				var qj=j*4, dr=r-plte[qj], dg=g-plte[qj+1], db=b-plte[qj+2], da=a-plte[qj+3];
				var err = dr*dr+dg*dg+db*db+da*da;
				if(err<te) {te=err;  ti=j;}
			}
			nd[i] = Math.sqrt(te)*0.5;  nd[i]=nd[i]*nd[i];
		}
		
		for(var i=0; i<sb.length; i+=4) {
			var r=sb[i  ], g=sb[i+1], b=sb[i+2], a=sb[i+3];
			var ti=inds[i>>>2], qi=ti*4, dr=r-plte[qi], dg=g-plte[qi+1], db=b-plte[qi+2], da=a-plte[qi+3], te = dr*dr+dg*dg+db*db+da*da;
			if(te>nd[ti]) for(var j=0; j<K; j++) {
				qi=j*4; dr=r-plte[qi]; dg=g-plte[qi+1]; db=b-plte[qi+2]; da=a-plte[qi+3];
				var err = dr*dr+dg*dg+db*db+da*da;
				if(err<te) {te=err;  ti=j;  if(te<nd[j]) break; }
			}
			inds[i>>>2]=ti;
			terr+=te;
		}
		return terr/(sb.length>>>2);
	}

	function getKDtree(nimg, ps, err) {
		if(err==null) err = 0.0001;
		var nimg32 = new Uint32Array(nimg.buffer);
		
		var root = {i0:0, i1:nimg.length, bst:null, est:null, tdst:0, left:null, right:null };  // basic statistic, extra statistic
		root.bst = stats(  nimg,root.i0, root.i1  );  root.est = estats( root.bst );
		var leafs = [root];
		
		while(leafs.length<ps)
		{
			var maxL = 0, mi=0;
			for(var i=0; i<leafs.length; i++) if(leafs[i].est.L > maxL) {  maxL=leafs[i].est.L;  mi=i;  }
			if(maxL<err) break;
			var node = leafs[mi];
			
			var s0 = splitPixels(nimg,nimg32, node.i0, node.i1, node.est.e, node.est.eMq255);
			var s0wrong = (node.i0>=s0 || node.i1<=s0);
			//console.log(maxL, leafs.length, mi);
			if(s0wrong) {  node.est.L=0;  continue;  }
			
			
			var ln = {i0:node.i0, i1:s0, bst:null, est:null, tdst:0, left:null, right:null };  ln.bst = stats( nimg, ln.i0, ln.i1 );  
			ln.est = estats( ln.bst );
			var rn = {i0:s0, i1:node.i1, bst:null, est:null, tdst:0, left:null, right:null };  rn.bst = {R:[], m:[], N:node.bst.N-ln.bst.N};
			for(var i=0; i<16; i++) rn.bst.R[i] = node.bst.R[i]-ln.bst.R[i];
			for(var i=0; i< 4; i++) rn.bst.m[i] = node.bst.m[i]-ln.bst.m[i];
			rn.est = estats( rn.bst );
			
			node.left = ln;  node.right = rn;
			leafs[mi]=ln;  leafs.push(rn);
		}
		leafs.sort(function(a,b) {  return b.bst.N-a.bst.N;  });
		for(var i=0; i<leafs.length; i++) leafs[i].ind=i;
		return [root, leafs];
	}

	function getNearest(nd, r,g,b,a)
	{
		if(nd.left==null) {  nd.tdst = dist(nd.est.q,r,g,b,a);  return nd;  }
		var pd = planeDst(nd.est,r,g,b,a);
		
		var node0 = nd.left, node1 = nd.right;
		if(pd>0) {  node0=nd.right;  node1=nd.left;  }
		
		var ln = getNearest(node0, r,g,b,a);
		if(ln.tdst<=pd*pd) return ln;
		var rn = getNearest(node1, r,g,b,a);
		return rn.tdst<ln.tdst ? rn : ln;
	}
	function planeDst(est, r,g,b,a) {  var e = est.e;  return e[0]*r + e[1]*g + e[2]*b + e[3]*a - est.eMq;  }
	function dist    (q,   r,g,b,a) {  var d0=r-q[0], d1=g-q[1], d2=b-q[2], d3=a-q[3];  return d0*d0+d1*d1+d2*d2+d3*d3;  }

	function splitPixels(nimg, nimg32, i0, i1, e, eMq)
	{
		i1-=4;
		var shfs = 0;
		while(i0<i1)
		{
			while(vecDot(nimg, i0, e)<=eMq) i0+=4;
			while(vecDot(nimg, i1, e)> eMq) i1-=4;
			if(i0>=i1) break;
			
			var t = nimg32[i0>>2];  nimg32[i0>>2] = nimg32[i1>>2];  nimg32[i1>>2]=t;
			
			i0+=4;  i1-=4;
		}
		while(vecDot(nimg, i0, e)>eMq) i0-=4;
		return i0+4;
	}
	function vecDot(nimg, i, e)
	{
		return nimg[i]*e[0] + nimg[i+1]*e[1] + nimg[i+2]*e[2] + nimg[i+3]*e[3];
	}
	function stats(nimg, i0, i1){
		var R = [0,0,0,0,  0,0,0,0,  0,0,0,0,  0,0,0,0];
		var m = [0,0,0,0];
		var N = (i1-i0)>>2;
		for(var i=i0; i<i1; i+=4)
		{
			var r = nimg[i]*(1/255), g = nimg[i+1]*(1/255), b = nimg[i+2]*(1/255), a = nimg[i+3]*(1/255);
			//var r = nimg[i], g = nimg[i+1], b = nimg[i+2], a = nimg[i+3];
			m[0]+=r;  m[1]+=g;  m[2]+=b;  m[3]+=a;
			
			R[ 0] += r*r;  R[ 1] += r*g;  R[ 2] += r*b;  R[ 3] += r*a;  
						   R[ 5] += g*g;  R[ 6] += g*b;  R[ 7] += g*a; 
										  R[10] += b*b;  R[11] += b*a;  
														 R[15] += a*a;  
		}
		R[4]=R[1];  R[8]=R[2];  R[9]=R[6];  R[12]=R[3];  R[13]=R[7];  R[14]=R[11];
		
		return {R:R, m:m, N:N};
	}
	function estats(stats){
		var R = stats.R, m = stats.m, N = stats.N;
		
		// when all samples are equal, but N is large (millions), the Rj can be non-zero ( 0.0003.... - precission error)
		var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], iN = (N==0 ? 0 : 1/N);
		var Rj = [
			R[ 0] - m0*m0*iN,  R[ 1] - m0*m1*iN,  R[ 2] - m0*m2*iN,  R[ 3] - m0*m3*iN,  
			R[ 4] - m1*m0*iN,  R[ 5] - m1*m1*iN,  R[ 6] - m1*m2*iN,  R[ 7] - m1*m3*iN,
			R[ 8] - m2*m0*iN,  R[ 9] - m2*m1*iN,  R[10] - m2*m2*iN,  R[11] - m2*m3*iN,  
			R[12] - m3*m0*iN,  R[13] - m3*m1*iN,  R[14] - m3*m2*iN,  R[15] - m3*m3*iN 
		];
		
		var A = Rj, M = M4;
		var b = [Math.random(),Math.random(),Math.random(),Math.random()], mi = 0, tmi = 0;
		
		if(N!=0)
		for(var i=0; i<16; i++) {
			b = M.multVec(A, b);  tmi = Math.sqrt(M.dot(b,b));  b = M.sml(1/tmi,  b);
			if(i!=0 && Math.abs(tmi-mi)<1e-9) break;  mi = tmi;
		}	
		//b = [0,0,1,0];  mi=N;
		var q = [m0*iN, m1*iN, m2*iN, m3*iN];
		var eMq255 = M.dot(M.sml(255,q),b);
		
		return {  Cov:Rj, q:q, e:b, L:mi,  eMq255:eMq255, eMq : M.dot(b,q),
					rgba: (((Math.round(255*q[3])<<24) | (Math.round(255*q[2])<<16) |  (Math.round(255*q[1])<<8) | (Math.round(255*q[0])<<0))>>>0)  };
	}
	var M4 = {
		multVec : function(m,v) {
				return [
					m[ 0]*v[0] + m[ 1]*v[1] + m[ 2]*v[2] + m[ 3]*v[3],
					m[ 4]*v[0] + m[ 5]*v[1] + m[ 6]*v[2] + m[ 7]*v[3],
					m[ 8]*v[0] + m[ 9]*v[1] + m[10]*v[2] + m[11]*v[3],
					m[12]*v[0] + m[13]*v[1] + m[14]*v[2] + m[15]*v[3]
				];
		},
		dot : function(x,y) {  return  x[0]*y[0]+x[1]*y[1]+x[2]*y[2]+x[3]*y[3];  },
		sml : function(a,y) {  return [a*y[0],a*y[1],a*y[2],a*y[3]];  }
	}

	function concatRGBA(bufs) {
		var tlen = 0;
		for(var i=0; i<bufs.length; i++) tlen += bufs[i].byteLength;
		var nimg = new Uint8Array(tlen), noff=0;
		for(var i=0; i<bufs.length; i++) {
			var img = new Uint8Array(bufs[i]), il = img.length;
			for(var j=0; j<il; j+=4) {  
				var r=img[j], g=img[j+1], b=img[j+2], a = img[j+3];
				if(a==0) r=g=b=0;
				nimg[noff+j]=r;  nimg[noff+j+1]=g;  nimg[noff+j+2]=b;  nimg[noff+j+3]=a;  }
			noff += il;
		}
		return nimg.buffer;
	}
	
	UPNG.encode = encode;
	UPNG.encodeLL = encodeLL;
	UPNG.encode.compress = compress;
	UPNG.encode.dither = dither;
	
	UPNG.quantize = quantize;
	UPNG.quantize.findNearest=findNearest;
	UPNG.quantize.getKDtree=getKDtree;
	UPNG.quantize.getNearest=getNearest;
    return { decode: function() {}, toRGBA8: function() {}, encode: function() {} };
})();


// --- 3. bmp-js (wrapped for browser) ---
// Here we wrap the bmp-js library to work in the browser.
var BmpDecoder = (function() {
    /**
 * @author shaozilee
 *
 * Bmp format decoder,support 1bit 4bit 8bit 24bit bmp
 *
 */

function BmpDecoder(buffer,is_with_alpha) {
  this.pos = 0;
  this.buffer = buffer;
  this.is_with_alpha = !!is_with_alpha;
  this.bottom_up = true;
  this.flag = this.buffer.toString("utf-8", 0, this.pos += 2);
  if (this.flag != "BM") throw new Error("Invalid BMP File");
  this.parseHeader();
  this.parseRGBA();
}

BmpDecoder.prototype.parseHeader = function() {
  this.fileSize = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.reserved = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.offset = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.headerSize = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.width = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.height = this.buffer.readInt32LE(this.pos);
  this.pos += 4;
  this.planes = this.buffer.readUInt16LE(this.pos);
  this.pos += 2;
  this.bitPP = this.buffer.readUInt16LE(this.pos);
  this.pos += 2;
  this.compress = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.rawSize = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.hr = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.vr = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.colors = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;
  this.importantColors = this.buffer.readUInt32LE(this.pos);
  this.pos += 4;

  if(this.bitPP === 16 && this.is_with_alpha){
    this.bitPP = 15
  }
  if (this.bitPP < 15) {
    var len = this.colors === 0 ? 1 << this.bitPP : this.colors;
    this.palette = new Array(len);
    for (var i = 0; i < len; i++) {
      var blue = this.buffer.readUInt8(this.pos++);
      var green = this.buffer.readUInt8(this.pos++);
      var red = this.buffer.readUInt8(this.pos++);
      var quad = this.buffer.readUInt8(this.pos++);
      this.palette[i] = {
        red: red,
        green: green,
        blue: blue,
        quad: quad
      };
    }
  }
  if(this.height < 0) {
    this.height *= -1;
    this.bottom_up = false;
  }

}

BmpDecoder.prototype.parseRGBA = function() {
    var bitn = "bit" + this.bitPP;
    var len = this.width * this.height * 4;
    this.data = new Buffer(len);
    this[bitn]();
};

BmpDecoder.prototype.bit1 = function() {
  var xlen = Math.ceil(this.width / 8);
  var mode = xlen%4;
  var y = this.height >= 0 ? this.height - 1 : -this.height
  for (var y = this.height - 1; y >= 0; y--) {
    var line = this.bottom_up ? y : this.height - 1 - y
    for (var x = 0; x < xlen; x++) {
      var b = this.buffer.readUInt8(this.pos++);
      var location = line * this.width * 4 + x*8*4;
      for (var i = 0; i < 8; i++) {
        if(x*8+i<this.width){
          var rgb = this.palette[((b>>(7-i))&0x1)];

          this.data[location+i*4] = 0;
          this.data[location+i*4 + 1] = rgb.blue;
          this.data[location+i*4 + 2] = rgb.green;
          this.data[location+i*4 + 3] = rgb.red;

        }else{
          break;
        }
      }
    }

    if (mode != 0){
      this.pos+=(4 - mode);
    }
  }
};

BmpDecoder.prototype.bit4 = function() {
    //RLE-4
    if(this.compress == 2){
        this.data.fill(0xff);

        var location = 0;
        var lines = this.bottom_up?this.height-1:0;
        var low_nibble = false;//for all count of pixel

        while(location<this.data.length){
            var a = this.buffer.readUInt8(this.pos++);
            var b = this.buffer.readUInt8(this.pos++);
            //absolute mode
            if(a == 0){
                if(b == 0){//line end
                    if(this.bottom_up){
                        lines--;
                    }else{
                        lines++;
                    }
                    location = lines*this.width*4;
                    low_nibble = false;
                    continue;
                }else if(b == 1){//image end
                    break;
                }else if(b ==2){
                    //offset x,y
                    var x = this.buffer.readUInt8(this.pos++);
                    var y = this.buffer.readUInt8(this.pos++);
                    if(this.bottom_up){
                        lines-=y;
                    }else{
                        lines+=y;
                    }

                    location +=(y*this.width*4+x*4);
                }else{
                    var c = this.buffer.readUInt8(this.pos++);
                    for(var i=0;i<b;i++){
                        if (low_nibble) {
                            setPixelData.call(this, (c & 0x0f));
                        } else {
                            setPixelData.call(this, (c & 0xf0)>>4);
                        }

                        if ((i & 1) && (i+1 < b)){
                            c = this.buffer.readUInt8(this.pos++);
                        }

                        low_nibble = !low_nibble;
                    }

                    if ((((b+1) >> 1) & 1 ) == 1){
                        this.pos++
                    }
                }

            }else{//encoded mode
                for (var i = 0; i < a; i++) {
                    if (low_nibble) {
                        setPixelData.call(this, (b & 0x0f));
                    } else {
                        setPixelData.call(this, (b & 0xf0)>>4);
                    }
                    low_nibble = !low_nibble;
                }
            }

        }




        function setPixelData(rgbIndex){
            var rgb = this.palette[rgbIndex];
            this.data[location] = 0;
            this.data[location + 1] = rgb.blue;
            this.data[location + 2] = rgb.green;
            this.data[location + 3] = rgb.red;
            location+=4;
        }
    }else{

      var xlen = Math.ceil(this.width/2);
      var mode = xlen%4;
      for (var y = this.height - 1; y >= 0; y--) {
        var line = this.bottom_up ? y : this.height - 1 - y
        for (var x = 0; x < xlen; x++) {
          var b = this.buffer.readUInt8(this.pos++);
          var location = line * this.width * 4 + x*2*4;

          var before = b>>4;
          var after = b&0x0F;

          var rgb = this.palette[before];
          this.data[location] = 0;
          this.data[location + 1] = rgb.blue;
          this.data[location + 2] = rgb.green;
          this.data[location + 3] = rgb.red;


          if(x*2+1>=this.width)break;

          rgb = this.palette[after];

          this.data[location+4] = 0;
          this.data[location+4 + 1] = rgb.blue;
          this.data[location+4 + 2] = rgb.green;
          this.data[location+4 + 3] = rgb.red;

        }

        if (mode != 0){
          this.pos+=(4 - mode);
        }
      }

    }

};

BmpDecoder.prototype.bit8 = function() {
    //RLE-8
    if(this.compress == 1){
        this.data.fill(0xff);

        var location = 0;
        var lines = this.bottom_up?this.height-1:0;

        while(location<this.data.length){
            var a = this.buffer.readUInt8(this.pos++);
            var b = this.buffer.readUInt8(this.pos++);
            //absolute mode
            if(a == 0){
                if(b == 0){//line end
                    if(this.bottom_up){
                        lines--;
                    }else{
                        lines++;
                    }
                    location = lines*this.width*4;
                    continue;
                }else if(b == 1){//image end
                    break;
                }else if(b ==2){
                    //offset x,y
                    var x = this.buffer.readUInt8(this.pos++);
                    var y = this.buffer.readUInt8(this.pos++);
                    if(this.bottom_up){
                        lines-=y;
                    }else{
                        lines+=y;
                    }

                    location +=(y*this.width*4+x*4);
                }else{
                    for(var i=0;i<b;i++){
                        var c = this.buffer.readUInt8(this.pos++);
                        setPixelData.call(this, c);
                    }
                    if(b&1 == 1){
                        this.pos++;
                    }

                }

            }else{//encoded mode
                for (var i = 0; i < a; i++) {
                    setPixelData.call(this, b);
                }
            }

        }




        function setPixelData(rgbIndex){
            var rgb = this.palette[rgbIndex];
            this.data[location] = 0;
            this.data[location + 1] = rgb.blue;
            this.data[location + 2] = rgb.green;
            this.data[location + 3] = rgb.red;
            location+=4;
        }
    }else {
        var mode = this.width % 4;
        for (var y = this.height - 1; y >= 0; y--) {
            var line = this.bottom_up ? y : this.height - 1 - y
            for (var x = 0; x < this.width; x++) {
                var b = this.buffer.readUInt8(this.pos++);
                var location = line * this.width * 4 + x * 4;
                if (b < this.palette.length) {
                    var rgb = this.palette[b];

                    this.data[location] = 0;
                    this.data[location + 1] = rgb.blue;
                    this.data[location + 2] = rgb.green;
                    this.data[location + 3] = rgb.red;

                } else {
                    this.data[location] = 0;
                    this.data[location + 1] = 0xFF;
                    this.data[location + 2] = 0xFF;
                    this.data[location + 3] = 0xFF;
                }
            }
            if (mode != 0) {
                this.pos += (4 - mode);
            }
        }
    }
};

BmpDecoder.prototype.bit15 = function() {
  var dif_w =this.width % 3;
  var _11111 = parseInt("11111", 2),_1_5 = _11111;
  for (var y = this.height - 1; y >= 0; y--) {
    var line = this.bottom_up ? y : this.height - 1 - y
    for (var x = 0; x < this.width; x++) {

      var B = this.buffer.readUInt16LE(this.pos);
      this.pos+=2;
      var blue = (B & _1_5) / _1_5 * 255 | 0;
      var green = (B >> 5 & _1_5 ) / _1_5 * 255 | 0;
      var red = (B >> 10 & _1_5) / _1_5 * 255 | 0;
      var alpha = (B>>15)?0xFF:0x00;

      var location = line * this.width * 4 + x * 4;

      this.data[location] = alpha;
      this.data[location + 1] = blue;
      this.data[location + 2] = green;
      this.data[location + 3] = red;
    }
    //skip extra bytes
    this.pos += dif_w;
  }
};

BmpDecoder.prototype.bit16 = function() {
  var dif_w =(this.width % 2)*2;
  //default xrgb555
  this.maskRed = 0x7C00;
  this.maskGreen = 0x3E0;
  this.maskBlue =0x1F;
  this.mask0 = 0;

  if(this.compress == 3){
    this.maskRed = this.buffer.readUInt32LE(this.pos);
    this.pos+=4;
    this.maskGreen = this.buffer.readUInt32LE(this.pos);
    this.pos+=4;
    this.maskBlue = this.buffer.readUInt32LE(this.pos);
    this.pos+=4;
    this.mask0 = this.buffer.readUInt32LE(this.pos);
    this.pos+=4;
  }


  var ns=[0,0,0];
  for (var i=0;i<16;i++){
    if ((this.maskRed>>i)&0x01) ns[0]++;
    if ((this.maskGreen>>i)&0x01) ns[1]++;
    if ((this.maskBlue>>i)&0x01) ns[2]++;
  }
  ns[1]+=ns[0]; ns[2]+=ns[1];	ns[0]=8-ns[0]; ns[1]-=8; ns[2]-=8;

  for (var y = this.height - 1; y >= 0; y--) {
    var line = this.bottom_up ? y : this.height - 1 - y;
    for (var x = 0; x < this.width; x++) {

      var B = this.buffer.readUInt16LE(this.pos);
      this.pos+=2;

      var blue = (B&this.maskBlue)<<ns[0];
      var green = (B&this.maskGreen)>>ns[1];
      var red = (B&this.maskRed)>>ns[2];

      var location = line * this.width * 4 + x * 4;

      this.data[location] = 0;
      this.data[location + 1] = blue;
      this.data[location + 2] = green;
      this.data[location + 3] = red;
    }
    //skip extra bytes
    this.pos += dif_w;
  }
};

BmpDecoder.prototype.bit24 = function() {
  for (var y = this.height - 1; y >= 0; y--) {
    var line = this.bottom_up ? y : this.height - 1 - y
    for (var x = 0; x < this.width; x++) {
      //Little Endian rgb
      var blue = this.buffer.readUInt8(this.pos++);
      var green = this.buffer.readUInt8(this.pos++);
      var red = this.buffer.readUInt8(this.pos++);
      var location = line * this.width * 4 + x * 4;
      this.data[location] = 0;
      this.data[location + 1] = blue;
      this.data[location + 2] = green;
      this.data[location + 3] = red;
    }
    //skip extra bytes
    this.pos += (this.width % 4);
  }

};

/**
 * add 32bit decode func
 * @author soubok
 */
BmpDecoder.prototype.bit32 = function() {
  //BI_BITFIELDS
  if(this.compress == 3){
    this.maskRed = this.buffer.readUInt32LE(this.pos);
    this.pos+=4;
    this.maskGreen = this.buffer.readUInt32LE(this.pos);
    this.pos+=4;
    this.maskBlue = this.buffer.readUInt32LE(this.pos);
    this.pos+=4;
    this.mask0 = this.buffer.readUInt32LE(this.pos);
    this.pos+=4;
      for (var y = this.height - 1; y >= 0; y--) {
          var line = this.bottom_up ? y : this.height - 1 - y;
          for (var x = 0; x < this.width; x++) {
              //Little Endian rgba
              var alpha = this.buffer.readUInt8(this.pos++);
              var blue = this.buffer.readUInt8(this.pos++);
              var green = this.buffer.readUInt8(this.pos++);
              var red = this.buffer.readUInt8(this.pos++);
              var location = line * this.width * 4 + x * 4;
              this.data[location] = alpha;
              this.data[location + 1] = blue;
              this.data[location + 2] = green;
              this.data[location + 3] = red;
          }
      }

  }else{
      for (var y = this.height - 1; y >= 0; y--) {
          var line = this.bottom_up ? y : this.height - 1 - y;
          for (var x = 0; x < this.width; x++) {
              //Little Endian argb
              var blue = this.buffer.readUInt8(this.pos++);
              var green = this.buffer.readUInt8(this.pos++);
              var red = this.buffer.readUInt8(this.pos++);
              var alpha = this.buffer.readUInt8(this.pos++);
              var location = line * this.width * 4 + x * 4;
              this.data[location] = alpha;
              this.data[location + 1] = blue;
              this.data[location + 2] = green;
              this.data[location + 3] = red;
          }
      }

  }




};

BmpDecoder.prototype.getData = function() {
  return this.data;
};
    return { decode: decode };
})();


// =========================================================================
// == 我们的应用逻辑
// =========================================================================

(function() {
    'use strict';

    // --- 加密/解密核心逻辑 ---

    const MAGIC_PIXEL_PATTERN = [
        { r: 0xDE, g: 0xAD, b: 0xBE, a: 0xEF },
        { r: 0xCA, g: 0xFE, b: 0xBA, a: 0xBE },
        { r: 0xFE, g: 0xED, b: 0xDE, a: 0xED },
        { r: 0xDA, g: 0x7A, b: 0xB0, a: 0x55 },
    ];
    const CHANNELS = 4;

    function generateMagicRow(width) {
        const magicRow = new Uint8Array(width * CHANNELS);
        for (let j = 0; j < width; j++) {
            const patternPixel = MAGIC_PIXEL_PATTERN[j % MAGIC_PIXEL_PATTERN.length];
            const offset = j * CHANNELS;
            magicRow[offset] = patternPixel.r;
            magicRow[offset + 1] = patternPixel.g;
            magicRow[offset + 2] = patternPixel.b;
            magicRow[offset + 3] = patternPixel.a;
        }
        return magicRow;
    }

    function areBuffersEqual(buf1, buf2) {
        if (!buf1 || !buf2 || buf1.byteLength !== buf2.byteLength) return false;
        const view1 = new DataView(buf1.buffer, buf1.byteOffset, buf1.byteLength);
        const view2 = new DataView(buf2.buffer, buf2.byteOffset, buf2.byteLength);
        for (let i = 0; i < buf1.byteLength; i++) {
            if (view1.getUint8(i) !== view2.getUint8(i)) return false;
        }
        return true;
    }

    function isEncrypted(pixelData, width, height) {
        if (height < 2) return false;
        const expectedMagicRow = generateMagicRow(width);
        const lastRowOffset = (height - 1) * width * CHANNELS;
        const lastRow = pixelData.subarray(lastRowOffset, lastRowOffset + width * CHANNELS);
        return areBuffersEqual(expectedMagicRow, lastRow);
    }

    function decodeImage(buffer) {
        const view = new Uint8Array(buffer);
        let type = 'UNKNOWN';
        if (view.length > 3 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) type = 'PNG';
        else if (view.length > 2 && view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) type = 'JPG';
        else if (view.length > 1 && view[0] === 0x42 && view[1] === 0x4D) type = 'BMP';

        if (type === 'PNG') {
            const img = UPNG.decode(buffer);
            return { width: img.width, height: img.height, data: new Uint8Array(UPNG.toRGBA8(img)[0]) };
        }
        if (type === 'JPG') {
            return jpeg.decode(view, { useTArray: true });
        }
        if (type === 'BMP') {
            // Here you would have the actual BmpDecoder logic running
            return BmpDecoder.decode(view);
        }
        throw new Error(`不支持的图片格式 (${type}) 或文件已损坏。`);
    }

    // 图片处理的主函数
    async function processImageFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const buffer = event.target.result;
                    const { width, height, data: pixels } = decodeImage(buffer);
                    
                    if (!width || !height || !pixels) {
                        throw new Error("解码失败，无法获取图片数据。");
                    }

                    let outputPngBuffer;
                    
                    if (isEncrypted(pixels, width, height)) {
                        // --- 解密流程 ---
                        const originalHeight = height - 2;
                        if (originalHeight <= 0) throw new Error("无效的加密文件，高度不足。");

                        const keyRow = pixels.subarray(0, width * CHANNELS);
                        const encryptedData = pixels.subarray(width * CHANNELS, (height - 1) * width * CHANNELS);
                        const decryptedData = new Uint8Array(width * originalHeight * CHANNELS);

                        for (let i = 0; i < originalHeight; i++) {
                            for (let j = 0; j < width; j++) {
                                const keyPixelIndex = ((i * width + j) % width);
                                const keyOffset = keyPixelIndex * CHANNELS;
                                const sourceOffset = (i * width + j) * CHANNELS;

                                for (let c = 0; c < CHANNELS; c++) {
                                    decryptedData[sourceOffset + c] = encryptedData[sourceOffset + c] ^ keyRow[keyOffset + c];
                                }
                            }
                        }
                        // 使用无压缩编码以提高速度
                        outputPngBuffer = UPNG.encode([decryptedData.buffer], width, originalHeight, 0);
                    } else {
                        // --- 加密流程 ---
                        const newHeight = height + 2;
                        const encryptedData = new Uint8Array(width * newHeight * CHANNELS);
                        
                        // 1. 生成随机密钥行
                        const keyRow = new Uint8Array(width * CHANNELS);
                        crypto.getRandomValues(keyRow);
                        encryptedData.set(keyRow, 0);

                        // 2. 加密像素
                        for (let i = 0; i < height; i++) {
                            for (let j = 0; j < width; j++) {
                                const keyPixelIndex = ((i * width + j) % width);
                                const keyOffset = keyPixelIndex * CHANNELS;
                                const sourceOffset = (i * width + j) * CHANNELS;
                                const destOffset = ((i + 1) * width + j) * CHANNELS;

                                for (let c = 0; c < CHANNELS; c++) {
                                    encryptedData[destOffset + c] = pixels[sourceOffset + c] ^ keyRow[keyOffset + c];
                                }
                            }
                        }

                        // 3. 加入 Magic 行
                        const magicRow = generateMagicRow(width);
                        encryptedData.set(magicRow, (newHeight - 1) * width * CHANNELS);
                        outputPngBuffer = UPNG.encode([encryptedData.buffer], width, newHeight, 0);
                    }
                    
                    const imageBlob = new Blob([outputPngBuffer], { type: 'image/png' });
                    const isEncryptedFile = file.name.endsWith('.png') && isEncrypted(pixels, width, height);
                    const newFileName = isEncryptedFile ? `decrypted-${file.name}` : `encrypted-${file.name.split('.').slice(0, -1).join('.') || file.name}.png`;
                    
                    resolve({ name: newFileName, blob: imageBlob });
                } catch (error) {
                    console.error("处理图片时发生错误:", error);
                    reject(error);
                }
            };
            reader.onerror = (error) => reject(error);
            reader.readAsArrayBuffer(file);
        });
    }

    // --- 前端交互逻辑 ---
    const fileInput = document.getElementById('fileInput');
    const uploadButton = document.getElementById('uploadButton');
    const downloadButton = document.getElementById('downloadButton');
    const resultsGrid = document.getElementById('results');
    let processedFiles = [];

    uploadButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => {
        const files = event.target.files;
        if (files.length > 0) {
            handleFileUpload(Array.from(files));
        }
    });
    downloadButton.addEventListener('click', downloadAllAsZip);

    async function handleFileUpload(files) {
        resultsGrid.innerHTML = '';
        processedFiles = [];
        uploadButton.disabled = true;
        downloadButton.disabled = true;

        files.forEach(file => createResultCard(file.name));

        const promises = files.map(file => {
            return processImageFile(file)
                .then(result => {
                    // 成功后，将结果存储起来，并更新卡片
                    processedFiles.push(result);
                    updateCardStatus(file.name, 'success', '处理成功', result.blob);
                })
                .catch(error => {
                    // 失败后，只更新卡片
                    updateCardStatus(file.name, 'error', error.message, null);
                });
        });

        await Promise.allSettled(promises);

        uploadButton.disabled = false;
        if (processedFiles.length > 0) {
            downloadButton.disabled = false;
        }
        fileInput.value = ''; 
    }

    function createResultCard(fileName) {
        const card = document.createElement('div');
        card.className = 'result-card';
        card.id = `card-${fileName.replace(/[^a-zA-Z0-9]/g, '-')}`; // 创建一个合法 ID
        card.innerHTML = `
            <div class="thumbnail-container">
                <div class="spinner"></div>
            </div>
            <p>${fileName}</p>
            <div class="status-container"></div>
        `;
        resultsGrid.appendChild(card);
    }

    function updateCardStatus(fileName, status, message, blob) {
        const cardId = `card-${fileName.replace(/[^a-zA-Z0-9]/g, '-')}`;
        const card = document.getElementById(cardId);
        if (!card) return;

        const thumbnailContainer = card.querySelector('.thumbnail-container');
        const statusContainer = card.querySelector('.status-container');

        thumbnailContainer.innerHTML = ''; 
        statusContainer.innerHTML = '';

        if (status === 'success' && blob) {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(blob);
            thumbnailContainer.appendChild(img);
            
            const statusBadge = document.createElement('span');
            statusBadge.className = 'status success';
            statusBadge.textContent = message;
            statusContainer.appendChild(statusBadge);

        } else if (status === 'error') {
            thumbnailContainer.textContent = '❌';
            const statusBadge = document.createElement('span');
            statusBadge.className = 'status error';
            statusBadge.textContent = message;
            statusContainer.appendChild(statusBadge);
        }
    }

    async function downloadAllAsZip() {
        if (processedFiles.length === 0) return;

        const zip = new JSZip();
        
        processedFiles.forEach(file => {
            zip.file(file.name, file.blob);
        });

        const zipBlob = await zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: { level: 9 }
        });

        const link = document.createElement('a');
        link.href = URL.createObjectURL(zipBlob);
        link.download = `processed-images-${Date.now()}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }

})();

