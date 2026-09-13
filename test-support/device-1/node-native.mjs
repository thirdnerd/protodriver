import {EventEmitter} from "node:events";
import {NodeSerialTransport} from "../../packages/transport-node-serial/src/index.ts";
import {fixture,line,lifecycle,identity} from "./fixture.mjs";
export function native(input,protocolDuplex,observe){
  const f=fixture(input,observe);
  class FakePort extends EventEmitter{
    isOpen=false;
    read(){return null;}
    open(callback){this.isOpen=true;f.receiver(b=>this.emit("data",Buffer.from(b)));callback(null);}
    close(callback){this.isOpen=false;this.emit("close",null);callback(null);}
    write(bytes,callback){callback(null);f.request(bytes,b=>this.emit("data",Buffer.from(b)));return true;}
  }
  const transport=new NodeSerialTransport({clock:f.clock,createPort:()=>new FakePort(),
    async enforceExclusive(_port){},
    async configureTermios(_port){},
  });
  return {...f,async open(){f.mark("open",{protocolDuplex});return f.observeConnection(await transport.open({
    path:"/fixture/device-1",profileId:"serial",modeId:"transfer",protocolDuplex,identity,line,lifecycle}));}};
}
