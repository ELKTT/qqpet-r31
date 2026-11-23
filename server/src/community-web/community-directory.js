// E-123: public selection data only. No credential, address or login success is exposed.
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 64
  && !/[\x00-\x1f\x7f]/.test(value);
const id = value => Number.isInteger(value) && value > 0 && value <= 65535;
const status = value => Number.isInteger(value) && value >= 0 && value <= 4;

export class CommunityDirectory {
  #regions;
  constructor(regions) {
    if (!Array.isArray(regions) || !regions.length || regions.length > 8)
      throw new TypeError('INVALID_COMMUNITY_DIRECTORY');
    const names=new Set(), zones=new Set();
    let areaCount=0;
    this.#regions=regions.map(region=>{
      if (!text(region?.Name) || names.has(region.Name) || !Array.isArray(region.Zooms)
          || !region.Zooms.length || region.Zooms.length>32)
        throw new TypeError('INVALID_COMMUNITY_REGION');
      names.add(region.Name);
      return {Name:region.Name,Zooms:region.Zooms.map(zone=>{
        if (!id(zone?.ID) || zones.has(zone.ID) || !text(zone.Name) || !status(zone.Status)
            || !Array.isArray(zone.Areas) || (areaCount+=zone.Areas.length)>512)
          throw new TypeError('INVALID_COMMUNITY_ZONE');
        zones.add(zone.ID);
        const rooms=new Set();
        return {ID:zone.ID,Name:zone.Name,Status:zone.Status,Areas:zone.Areas.map(area=>{
          if (!id(area?.ID) || rooms.has(area.ID) || !text(area.Name) || !status(area.Status))
            throw new TypeError('INVALID_COMMUNITY_AREA');
          rooms.add(area.ID);
          return {ID:area.ID,Name:area.Name,Status:area.Status};
        })};
      })};
    });
  }

  snapshot() {
    const first=this.#regions[0],zone=first.Zooms[0];
    return {defaults:{RegionName:first.Name,ZoomID:zone.ID,ZoomName:zone.Name,AreaID:0,AreaName:''},
      regions:structuredClone(this.#regions)};
  }
}

// A configured local destination under construction, not an advertised online server.
// SvrItem ABC 1:6758 maps Status=4 to maintenance and disables entry.
export function pendingCommunityDirectory() {
  return new CommunityDirectory([{Name:'本地社区',Zooms:[{ID:1,Name:'本地区服',Status:4,
    Areas:[{ID:1,Name:'社区建设中',Status:4}]}]}]);
}

export function localCommunityDirectory() {
  return new CommunityDirectory([{Name:'本地社区',Zooms:[{ID:1,Name:'企鹅镇',Status:0,
    Areas:[{ID:1,Name:'本地房间',Status:0}]}]}]);
}
