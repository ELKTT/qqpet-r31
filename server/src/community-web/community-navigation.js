// E-124: original NavigationMap PointList/CellList; local routing over shared triangle edges.
// PSW.PetFindPath returns [{x,y}, ...] synchronously (native RVA 201D0 -> 1F230).
const area=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const finite=n=>typeof n==='number' && Number.isFinite(n);
export class CommunityNavigation {
  constructor(data) {
    if(!Number.isInteger(data?.sceneId) || data.sceneId<1 || data.sceneId>65535 || !Number.isInteger(data.width) || data.width<1 || data.width>10000
        || !Number.isInteger(data.height) || data.height<1 || data.height>10000
        || !Array.isArray(data.points) || data.points.length<3 || data.points.length>10000
        || !Array.isArray(data.cells) || !data.cells.length || data.cells.length>10000)
      throw new TypeError('INVALID_NAVIGATION');
    this.width=data.width;this.height=data.height;
    this.points=data.points.map(p=>{
      if(!p || !finite(p.x) || !finite(p.y) || p.x<0 || p.y<0 || p.x>data.width || p.y>data.height)
        throw new TypeError('INVALID_NAVIGATION_POINT');
      return {x:p.x,y:p.y};
    });
    this.cells=data.cells.map(c=>{
      if(!Array.isArray(c) || c.length!==3 || new Set(c).size!==3
          || c.some(i=>!Number.isInteger(i)||i<0||i>=this.points.length))throw new TypeError('INVALID_NAVIGATION_CELL');
      const p=c.map(i=>this.points[i]);
      if(Math.abs(area(...p))<0.001)throw new TypeError('DEGENERATE_NAVIGATION_CELL');
      return {vertices:[...c],points:p,orientation:Math.sign(area(...p)),
        minX:Math.min(...p.map(v=>v.x)),maxX:Math.max(...p.map(v=>v.x)),
        minY:Math.min(...p.map(v=>v.y)),maxY:Math.max(...p.map(v=>v.y)),
        center:{x:(p[0].x+p[1].x+p[2].x)/3,y:(p[0].y+p[1].y+p[2].y)/3},edges:[]};
    });
    const edges=new Map();
    this.cells.forEach((c,index)=>{
      for(let j=0;j<3;j++) {
        const a=c.vertices[j],b=c.vertices[(j+1)%3],key=[Math.min(a,b),Math.max(a,b)].join(':');
        const previous=edges.get(key);
        if(previous) {
          if(previous.paired)throw new TypeError('NON_MANIFOLD_NAVIGATION');
          const pa=this.points[a],pb=this.points[b],portal={x:(pa.x+pb.x)/2,y:(pa.y+pb.y)/2};
          c.edges.push({next:previous.index,portal});this.cells[previous.index].edges.push({next:index,portal});previous.paired=true;
        } else edges.set(key,{index});
      }
    });
  }
  contains(index,p) {
    const v=this.cells[index].vertices.map(i=>this.points[i]),a=area(v[0],v[1],p),b=area(v[1],v[2],p),c=area(v[2],v[0],p);
    return !(Math.min(a,b,c)<-0.001 && Math.max(a,b,c)>0.001);
  }
  locate(p) {return this.cells.findIndex((_,i)=>this.contains(i,p));}
  segmentInside(start,end) {
    // Clip the complete segment against convex triangles, then check interval union.
    // Sampling only a few points can miss a narrow obstacle and is not sufficient.
    const intervals=[],minX=Math.min(start.x,end.x),maxX=Math.max(start.x,end.x),
      minY=Math.min(start.y,end.y),maxY=Math.max(start.y,end.y);
    for(const cell of this.cells) {
      if(cell.maxX<minX || cell.minX>maxX || cell.maxY<minY || cell.minY>maxY)continue;
      const v=cell.points,sign=cell.orientation;
      let low=0,high=1;
      for(let j=0;j<3;j++) {
        const a=sign*area(v[j],v[(j+1)%3],start),b=sign*area(v[j],v[(j+1)%3],end),delta=b-a;
        if(Math.abs(delta)<1e-9) {if(a< -1e-7){high=-1;break;}}
        else if(delta>0)low=Math.max(low,-a/delta);
        else high=Math.min(high,-a/delta);
      }
      if(low<=high+1e-9 && high>=0 && low<=1)intervals.push([Math.max(0,low),Math.min(1,high)]);
    }
    intervals.sort((a,b)=>a[0]-b[0]);
    let covered=0;
    for(const [low,high] of intervals) {
      if(low>covered+1e-9)return false;
      covered=Math.max(covered,high);if(covered>=1-1e-9)return true;
    }
    return false;
  }
  smooth(path) {
    const result=[path[0]];
    for(let from=0;from<path.length-1;) {
      let to=path.length-1;
      while(to>from+1 && !this.segmentInside(path[from],path[to]))to--;
      result.push(path[to]);from=to;
    }
    return result;
  }
  find(start,end) {
    if(![start,end].every(p=>p && finite(p.x) && finite(p.y) && p.x>=0 && p.x<this.width && p.y>=0 && p.y<this.height))return [];
    const first=this.locate(start),last=this.locate(end);
    if(first<0 || last<0)return [];
    if(first===last)return [{...start},{...end}];
    const open=new Set([first]),cost=new Map([[first,0]]),previous=new Map(),closed=new Set();
    while(open.size) {
      let current=-1,best=Infinity;
      for(const i of open){const score=cost.get(i)+distance(this.cells[i].center,this.cells[last].center);if(score<best){best=score;current=i;}}
      if(current===last) {
        const path=[{...end}];let i=last;
        while(i!==first){const edge=previous.get(i);path.push({...edge.portal});i=edge.from;}
        path.push({...start});path.reverse();
        const simple=[];
        for(const p of path){
          if(simple.length && distance(simple[simple.length-1],p)<0.001)continue;
          while(simple.length>1 && Math.abs(area(simple[simple.length-2],simple[simple.length-1],p))<0.001)simple.pop();
          simple.push(p);
        }
        // Bound the synchronous HTTP workload before smoothing long corridors.
        if(simple.length>1024)return [];
        const smoothed=this.smooth(simple);
        return smoothed.length<=512?smoothed:[];
      }
      open.delete(current);closed.add(current);
      for(const edge of this.cells[current].edges) {
        if(closed.has(edge.next))continue;
        const candidate=cost.get(current)+distance(this.cells[current].center,this.cells[edge.next].center);
        if(candidate<(cost.get(edge.next)??Infinity)){cost.set(edge.next,candidate);previous.set(edge.next,{from:current,portal:edge.portal});open.add(edge.next);}
      }
    }
    return [];
  }
}
