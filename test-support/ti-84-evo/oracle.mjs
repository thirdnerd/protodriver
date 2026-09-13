import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';

function predictor(filter,left,up,upperLeft){
  if(filter===0)return 0;if(filter===1)return left;if(filter===2)return up;if(filter===3)return Math.floor((left+up)/2);
  if(filter===4){const estimate=left+up-upperLeft,pa=Math.abs(estimate-left),pb=Math.abs(estimate-up),pc=Math.abs(estimate-upperLeft);
    return pa<=pb&&pa<=pc?left:pb<=pc?up:upperLeft;}
  assert.fail(`unsupported PNG filter ${filter}`);
}
function pngRgb(bytes){
  const buffer=Buffer.from(bytes);assert.equal(buffer.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let width,height,channels;const idat=[];
  for(let offset=8;offset<buffer.length;){const length=buffer.readUInt32BE(offset),type=buffer.subarray(offset+4,offset+8).toString('ascii'),data=buffer.subarray(offset+8,offset+8+length);
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);assert.equal(data[12],0);channels=data[9]===6?4:data[9]===2?3:0;assert.ok(channels);}
    else if(type==='IDAT')idat.push(data);offset+=12+length;
  }
  const scanlines=inflateSync(Buffer.concat(idat)),stride=width*channels,pixels=Buffer.alloc(width*height*channels);let input=0;const prior=Buffer.alloc(stride);
  for(let y=0;y<height;y++){const filter=scanlines[input++],row=Buffer.alloc(stride);
    for(let x=0;x<stride;x++){const left=x<channels?0:row[x-channels],up=prior[x],upperLeft=x<channels?0:prior[x-channels];row[x]=(scanlines[input++]+predictor(filter,left,up,upperLeft))&255;}
    row.copy(pixels,y*stride);row.copy(prior);
  }
  assert.equal(input,scanlines.length);return {width,height,channels,pixels};
}
export function compareEvoBmpToVendorPng(bmp,png){
  const reference=pngRgb(png);assert.equal(bmp.length,153666);assert.equal(bmp.subarray(0,2).toString(),'BM');
  assert.equal(bmp.readInt32LE(18),320);assert.equal(bmp.readInt32LE(22),-240);const dx=(reference.width-320)/2,dy=(reference.height-240)/2;
  assert.ok(Number.isInteger(dx)&&dx>=0&&Number.isInteger(dy)&&dy>=0);let matching=0;
  for(let y=0;y<240;y++)for(let x=0;x<320;x++){
    const value=bmp.readUInt16LE(66+2*(y*320+x)),r5=value>>>11,g6=(value>>>5)&0x3f,b5=value&0x1f;
    const got=[(r5<<3)|(r5>>>2),(g6<<2)|(g6>>>4),(b5<<3)|(b5>>>2)];
    const at=((y+dy)*reference.width+x+dx)*reference.channels;
    if(got[0]===reference.pixels[at]&&got[1]===reference.pixels[at+1]&&got[2]===reference.pixels[at+2])matching++;
  }
  return {matching,total:76800,width:reference.width,height:reference.height,inset:[dx,dy]};
}
