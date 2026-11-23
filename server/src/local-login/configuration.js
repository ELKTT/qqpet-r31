import {readFile,stat} from 'node:fs/promises';
import {randomBytes as systemRandomBytes} from 'node:crypto';
import path from 'node:path';
import {SqliteOriginalLoginStore} from '../original-data/sqlite-original-login-store.js';
import {parseOriginalWebdirProfileDocument} from '../original-webdir/webdir-profile-directory.js';
import {PostEntryState} from '../original-data/post-entry-state.js';
import {ServerAnimations} from '../original-data/server-animations.js';
import {OnlinePetState,validateOnlineVitalsPolicy} from '../original-data/online-pet-state.js';
import {PetMembership,validateMembershipPolicy} from '../original-data/pet-membership.js';
import {PetBusinessState,validatePetBusinessPolicy} from '../original-data/pet-business-state.js';
import {PetPlayRewards,validatePlayRewardsPolicy} from '../original-data/pet-play-rewards.js';
import {PetFriends} from '../original-data/pet-friends.js';
import {PetCareEconomy} from '../original-data/pet-care-economy.js';
import {PetHealth} from '../original-data/pet-health.js';
import {PetWardrobe} from '../original-data/pet-wardrobe.js';
import {loadWardrobeConfiguration} from '../original-data/wardrobe-configuration.js';
import {createWardrobeResources} from '../original-webdir/wardrobe-resources.js';
import {loadCareEconomyConfiguration} from '../original-data/care-economy-configuration.js';
import {DesktopTasks} from '../original-data/desktop-tasks.js';
import {DesktopToolbarResources} from '../original-webdir/desktop-toolbar-resources.js';
import {PlayMenuResources} from '../original-webdir/play-menu-resources.js';
import {LocalLoginClientServer} from './client-server.js';
import {parseWebdirZoneTemplate} from './zone-template.js';
import {WearableCatalogue} from '../original-webdir/wearable-catalogue.js';
import {AccountService,PetProvisioning} from '../accounts/account-service.js';
import {AccountAdmin,AccountEconomyAdmin,ItemPriceOverrides} from '../accounts/account-admin.js';
import {AccountWebServer} from '../accounts/account-web-server.js';
import {parseDeploymentEndpointsJson,MAX_DEPLOYMENT_CONFIG_BYTES} from '../deployment/endpoints.js';
import {resolveServerListener} from '../deployment/server-listener.js';
import {createRemoteCommunity} from '../deployment/remote-community.js';

async function document(filename,limit) {
  const resolved=path.resolve(filename);
  if((await stat(resolved)).size>limit)throw new Error('PROFILE_TOO_LARGE');
  return JSON.parse(await readFile(resolved,'utf8'));
}
async function policy(options,key,validate,optional=[]) {
  if(!options.has(key))return null;
  const config=await document(options.get(key),65536);
  if(!config || Array.isArray(config) || Object.keys(config).length!==2+optional.filter(k=>Object.hasOwn(config,k)).length
      ||Object.keys(config).some(k=>!['enabled','policy',...optional].includes(k))||typeof config.enabled!=='boolean' ||
      !Object.hasOwn(config,'policy'))throw new Error('INVALID_LOCAL_POLICY');
  validate(config.policy);return config;
}

// Reuse the existing domain/resource implementations and explicit configuration
// contracts. No reply-profile, TXSSO server or previous acceptance runner loads.
export async function loadLocalLoginServer(options) {
  if(options.has('--enable-native-avatar-preview')&&!options.has('--enable-html-market-compatibility'))
    throw new Error('NATIVE_AVATAR_PREVIEW_REQUIRES_MARKET_SWITCH');
  if(options.has('--wardrobe-profile')&&(!options.has('--enable-native-avatar-preview')||!options.has('--enable-html-market-compatibility')
    ||!options.has('--enable-legacy-community-home-compatibility')))throw new Error('WARDROBE_REQUIRES_COMPLETE_NATIVE_MARKET');
  const {legacyCommunityEntryEnabled}=await import('../original-webdir/legacy-community-entry-resources.js');
  const legacyEntryEnabled=legacyCommunityEntryEnabled(options);
  const legacyHomeEnabled=options.has('--enable-legacy-community-home-compatibility');
  if(legacyHomeEnabled!==options.has('--legacy-community-home-profile'))throw new Error('LEGACY_HOME_REQUIRES_EXPLICIT_PROFILE_AND_SWITCH');
  if(legacyHomeEnabled&&!legacyEntryEnabled)throw new Error('LEGACY_HOME_REQUIRES_LEGACY_ENTRY');
  let legacyRuntime;
  if(legacyHomeEnabled){
    const {loadLegacyCommunityRuntimeProfile}=await import('../original-webdir/legacy-community-runtime-resources.js');
    legacyRuntime=await loadLegacyCommunityRuntimeProfile(path.resolve(options.get('--legacy-community-home-profile')));
  }
  if(options.has('--friend-policy')&&!['all-server-pets','community-friends'].includes(options.get('--friend-policy')))
    throw new Error('INVALID_FRIEND_POLICY');
  // Validate deployment and override conflicts before opening any database or account service.
  let deploymentEndpoints;
  if(options.has('--deployment-endpoints')) {
    const filename=path.resolve(options.get('--deployment-endpoints'));
    if((await stat(filename)).size>MAX_DEPLOYMENT_CONFIG_BYTES)throw new Error('INVALID_DEPLOYMENT_CONFIG');
    deploymentEndpoints=parseDeploymentEndpointsJson(await readFile(filename,'utf8'));
  }
  const gamePort=options.has('--game-port')?Number(options.get('--game-port')):undefined;
  if(options.has('--enable-remote-community')&&deploymentEndpoints?.mode!=='remote')
    throw new Error('REMOTE_COMMUNITY_REQUIRES_DEPLOYMENT');
  if(options.has('--enable-legacy-resource-http')&&deploymentEndpoints?.mode!=='remote')throw new Error('LEGACY_HTTP_REQUIRES_REMOTE');
  const webdirPort=options.has('--webdir-port')?Number(options.get('--webdir-port')):undefined;
  resolveServerListener('game',{port:gamePort,deploymentEndpoints});
  resolveServerListener('web',{port:webdirPort,deploymentEndpoints,allowLegacyHttp80:Boolean(legacyRuntime)});
  if(legacyRuntime){
    const publicIp=deploymentEndpoints?.public.game.ipv4;
    const resourcePort=legacyRuntime.directory.resourcePort??80;
    const resourceDomain=publicIp+(resourcePort===80?'':':'+resourcePort);
    if(!deploymentEndpoints||deploymentEndpoints.public.webOrigin!=='http://'+publicIp+':'+resourcePort
      ||deploymentEndpoints.listen.web.port!==resourcePort
      ||legacyRuntime.directory.host!==deploymentEndpoints.listen.web.ipv4
      ||legacyRuntime.directory.resourceDomain!==resourceDomain
      ||(legacyRuntime.directory.publicIpv4??'127.0.0.1')!==publicIp
      ||legacyRuntime.directory.gamePort!==deploymentEndpoints.public.game.port)
      throw new Error('LEGACY_HOME_REQUIRES_OWNED_LOOPBACK_ENDPOINTS');
    if([deploymentEndpoints.listen.web.port,deploymentEndpoints.listen.game.port,deploymentEndpoints.listen.login.port,
      deploymentEndpoints.admin.listen.port].includes(legacyRuntime.directory.port))throw new Error('LEGACY_DIRECTORY_PORT_COLLISION');
  }
  if(deploymentEndpoints&&options.has('--account-web-port')
      &&Number(options.get('--account-web-port'))!==deploymentEndpoints.admin.listen.port)
    throw new Error('DEPLOYMENT_ADMIN_PORT_CONFLICT');
  let loginTls;
  if(options.has('--login-tls-cert')||options.has('--login-tls-key')) {
    if(!deploymentEndpoints||!options.has('--login-tls-cert')||!options.has('--login-tls-key'))throw new Error('LOGIN_TLS_REQUIRES_DEPLOYMENT_AND_PAIR');
    const files=[options.get('--login-tls-cert'),options.get('--login-tls-key')];
    for(const file of files)if((await stat(file)).size>16384)throw new Error('INVALID_LOGIN_TLS');
    const {validateLoginTls}=await import('../deployment/remote-login-server.js');
    loginTls=validateLoginTls(deploymentEndpoints,{cert:await readFile(files[0]),key:await readFile(files[1])});
  }
  if(!options.has('--database') || !options.has('--webdir-profile'))throw new Error('MISSING_CONFIGURATION');
  const filePath=path.resolve(options.get('--database'));
  if(!(await stat(filePath)).isFile())throw new Error('DATABASE_NOT_FOUND');
  const webdir=parseOriginalWebdirProfileDocument(await document(options.get('--webdir-profile'),1024*1024));
  // The zone/version block a fresh install derives start parameters from. It is declared beside
  // the run configuration and validated on its own: it names no account, no pet and no endpoint
  // port — the port is always the game listener this assembly actually opens.
  const webdirZoneTemplate=options.has('--webdir-zone-template')
    ?parseWebdirZoneTemplate(await document(options.get('--webdir-zone-template'),4096)):undefined;
  let playMenu;
  if(options.has('--play-menu-profile')) {
    const config=await document(options.get('--play-menu-profile'),8192);
    if(!['local-catalogue-level-5-original-command-resources','local-catalogue-original-command-resources'].includes(config.policy) ||
        !Array.isArray(config.entries) || ![5,7,8,9,12].includes(config.entries.length))throw new Error('INVALID_PLAY_POLICY');
    const entries=[];
    for(const entry of config.entries) {
      const adultOnly=[100,101,102,103].includes(entry.gameId)||entry.command===0x6207;
      if(!/^res\/Plugins\/(?:TickleSystem\/QuickBar\/(?:(tanliqiu|duolaoshu|tiaosheng|guess|paopao|fish|nongchang|danrendoule)00|100ceng|buyu|chaojipaopao|zhaixingxing)|Diudiule\/QuickBar\/diudiule\/diudiule00)\.png$/.test(entry.iconPath) || entry.level!==(adultOnly?10:entry.command===0x6202&&config.policy==='local-catalogue-original-command-resources'?1:5))
        throw new Error('INVALID_PLAY_ASSET');
      entries.push({...entry,icon:await readFile(new URL('../../resources/static/'+entry.iconPath,import.meta.url))});
    }
    playMenu=new PlayMenuResources(entries);
  }
  const store=new SqliteOriginalLoginStore({filePath});
  try {
    let legacyHome,legacyCommunity;
    if(legacyRuntime){
      const {LegacyHomeState}=await import('../original-data/legacy-home-state.js');
      legacyHome=new LegacyHomeState({database:store.database,policy:legacyRuntime.policy});
      const {LegacyCommunityState}=await import('../original-data/legacy-community-state.js');
      legacyCommunity=new LegacyCommunityState({database:store.database,policy:legacyRuntime.community});
    }
    // One account service per database: registration, authentication, the administrator panel and
    // the first adoption all run against the same rows the login server reads.
    const accountService=new AccountService({database:store.database,firstRegistrationAdmin:true});
    const memberConfig=await policy(options,'--membership-profile',validateMembershipPolicy);
    const vitalsConfig=await policy(options,'--online-vitals-profile',validateOnlineVitalsPolicy);
    const businessConfig=await policy(options,'--pet-business-profile',validatePetBusinessPolicy,['playRewards']);
    const playConfig=businessConfig?.playRewards;
    if(playConfig!==undefined){
      if(!playConfig||Object.keys(playConfig).sort().join('|')!=='enabled|policy'||typeof playConfig.enabled!=='boolean')
        throw Error('INVALID_PLAY_REWARDS_CONFIGURATION');
      validatePlayRewardsPolicy(playConfig.policy);
      if(playConfig.enabled&&(!businessConfig.enabled||!options.has('--post-entry-profile')))throw Error('PLAY_REQUIRES_ENABLED_BUSINESS');
    }
    if((memberConfig || vitalsConfig) && !options.has('--post-entry-profile'))throw new Error('VITALS_REQUIRES_POST_ENTRY');
    if(memberConfig && !vitalsConfig)throw new Error('MEMBERSHIP_REQUIRES_VITALS');
    const membership=memberConfig?.enabled?new PetMembership({database:store.database,policy:memberConfig.policy}):undefined;
    const onlineVitals=vitalsConfig?.enabled?new OnlinePetState({database:store.database,policy:vitalsConfig.policy,membership}):undefined;
    if(membership && !onlineVitals)throw new Error('MEMBERSHIP_REQUIRES_ENABLED_VITALS');
    if(businessConfig && !onlineVitals)throw new Error('BUSINESS_REQUIRES_ENABLED_VITALS');
    let careEconomy,careResources,priceOverrides;
    if(options.has('--care-economy-profile')) {
      if(!onlineVitals)throw new Error('CARE_REQUIRES_VITALS_AND_HTTP');
      const config=await loadCareEconomyConfiguration(path.resolve(options.get('--care-economy-profile')));
      if(config.enabled){
        // The local price table is read by the economy and written by the administrator panel, so
        // a price decision never edits the catalogue the saves are pinned to.
        priceOverrides=new ItemPriceOverrides({accounts:accountService,database:store.database});
        careEconomy=new PetCareEconomy({database:store.database,policy:config.policy,
          catalogueUpgrades:config.catalogueUpgrades,priceOverrides,functionalPrice:config.functionalPrice,membership});
        if(onlineVitals.policy.id==='local-online-vitals-v5')careEconomy.health=new PetHealth({database:store.database,onlineVitals,membership});
        careResources=config.resources;
      }
    }
    let wardrobe;
    if(options.has('--wardrobe-profile')) {
      if(!careEconomy||!legacyRuntime)throw new Error('WARDROBE_REQUIRES_SHARED_CARE_AND_RESOURCES');
      const configuration=await loadWardrobeConfiguration(path.resolve(options.get('--wardrobe-profile')),
        {resources:legacyRuntime.resources,authority:legacyRuntime.directory.resourceDomain});
      legacyRuntime.resources=createWardrobeResources({configuration,resources:legacyRuntime.resources,
        authority:legacyRuntime.directory.resourceDomain});
      wardrobe=new PetWardrobe({database:store.database,careEconomy,configuration,resourceOrigin:deploymentEndpoints.public.webOrigin});
    }
    let desktopTasks,toolbarResources;
    if(options.has('--enable-desktop-tasks')) {
      if(!onlineVitals || !options.has('--care-economy-profile'))throw new Error('TOOLBAR_REQUIRES_CARE_AND_VITALS');
      // The reward table names its prizes, so it is resolved against the catalogue that is
      // actually enabled: a prize whose name and cid disagree stops the server here.
      desktopTasks=new DesktopTasks({database:store.database,
        items:careEconomy?new Map(careEconomy.policy.items.map((entry)=>[entry.cid,entry])):undefined});
      desktopTasks.membership=membership;
      toolbarResources=new DesktopToolbarResources({operations:desktopTasks.operations});
      careEconomy?.attachDesktopTasks(desktopTasks);
    }
    if(options.has('--friend-policy')&&(!businessConfig?.enabled||!onlineVitals||!options.has('--post-entry-profile')))
      throw new Error('FRIENDS_REQUIRE_BUSINESS_AND_VITALS');
    const friends=options.has('--friend-policy')?new PetFriends({store,accounts:accountService,policy:options.get('--friend-policy')}):undefined;
    const petBusiness=businessConfig?.enabled?new PetBusinessState({database:store.database,policy:businessConfig.policy,membership,desktopTasks,friends}):undefined;
    const playRewards=playConfig?.enabled?new PetPlayRewards({database:store.database,petBusiness,policy:playConfig.policy}):undefined;
    let postEntryState;
    if(options.has('--post-entry-profile')) {
      const config=await document(options.get('--post-entry-profile'),4096);
      if(!config || Array.isArray(config) || Object.keys(config).length!==6+Number(Object.hasOwn(config,'logout'))+Number(Object.hasOwn(config,'onlineTimeDisplayPolicy'))+Number(Object.hasOwn(config,'serverAnimations')) ||
          Object.keys(config).some(key=>!['counterPolicy','interactionPolicy','unknownWordHex','initialOnlineSeconds','dailyTaskInfo','toolbarAd','logout','onlineTimeDisplayPolicy','serverAnimations'].includes(key)) ||
          (config.serverAnimations!==undefined&&typeof config.serverAnimations!=='boolean') ||
          config.counterPolicy!=='cumulative-connected-time' || config.interactionPolicy!=='native-failure-no-mutation')throw new Error('INVALID_POST_ENTRY_CONFIGURATION');
      const serverAnimations=config.serverAnimations?new ServerAnimations({database:store.database,catalog:JSON.parse(await readFile(new URL('../../resources/server-actions/catalog.json',import.meta.url),'utf8'))}):undefined;
      postEntryState=new PostEntryState({database:store.database,serverAnimations,unknownWordHex:config.unknownWordHex,initialOnlineSeconds:config.initialOnlineSeconds,
        dailyTaskInfo:config.dailyTaskInfo,toolbarAd:config.toolbarAd,logout:config.logout,onlineTimeDisplayPolicy:config.onlineTimeDisplayPolicy,
        onlineVitals,petBusiness,playRewards,membership,careEconomy,wardrobe,desktopTasks,ageHoursMirror:store,friends});
    }
    // Default-off HTML market capability: the page service copy and its API are one unit,
    // and the desktop menu responses are a second switch on top of it. The desktop switch
    // alone is refused instead of quietly building the market it depends on.
    let marketPages,desktopGame,legacyCommunityEntries;
    if(options.has('--enable-desktop-game-entry') && !options.has('--enable-html-market-compatibility'))
      throw new Error('DESKTOP_GAME_REQUIRES_MARKET_SWITCH');
    if(options.has('--enable-html-market-compatibility')) {
      if(!options.has('--market-client-root'))throw new Error('MARKET_REQUIRES_CLIENT_ROOT');
      if(!careEconomy)throw new Error('MARKET_REQUIRES_ENABLED_CARE_ECONOMY');
      const clientRoot=path.resolve(options.get('--market-client-root'));
      const manifest=JSON.parse(await readFile(new URL('../../resources/html-market/manifest.json',import.meta.url),'utf8'));
      const {loadMarketPageResources}=await import('../original-webdir/market-page-resources.js');
      marketPages=await loadMarketPageResources(clientRoot,manifest,{nativeAvatarPreview:options.has('--enable-native-avatar-preview'),wardrobeEnabled:Boolean(wardrobe),deploymentEndpoints});
      if(legacyEntryEnabled) {
        const {loadLegacyCommunityEntryResources}=await import('../original-webdir/legacy-community-entry-resources.js');
        legacyCommunityEntries=await loadLegacyCommunityEntryResources({enabled:true});
      }
      if(options.has('--enable-desktop-game-entry')) {
        const {DesktopGameResources}=await import('../original-webdir/desktop-game-resources.js');
        desktopGame=new DesktopGameResources({clientRoot,includeSupplemental:careEconomy.policy.id==='local-care-economy-v4'});
      }
    }
    // The registered wearable category: the deployed document and its hash-named artwork. It is
    // loaded when present and skipped when absent, so a run without the deployment serves the
    // rest of the shop and simply has no wearable category.
    let wearableCatalogue=null;
    const wearableConfig=path.resolve('server/config/wearable-registry.json');
    if((await stat(wearableConfig).then(()=>true).catch(()=>false)))
      wearableCatalogue=WearableCatalogue.load({configFile:wearableConfig,
        assetsRoot:path.resolve('server/assets/wearable')});
    // The account pages share the one account service and the one care economy; they are started
    // and stopped with this server rather than as a second long-running backend.
    // The administrator operations are wired to the running server's ticket issuer and game
    // connections afterwards, because those exist only once the server object does.
    const accountAdmin=new AccountAdmin({accounts:accountService,database:store.database});
    // The wider administrator scope needs the care economy, so it is offered only when one is
    // assembled; backups go under the project's own runtime directory.
    const economyAdmin=careEconomy
      ? new AccountEconomyAdmin({accounts:accountService,database:store.database,economy:careEconomy,
          backupsRoot:path.resolve(options.get('--account-backups-root')??'runtime/backups/accounts'),
          careProfileFile:path.resolve(options.get('--care-economy-profile'))})
      : null;
    // A staged catalogue generation whose activation was interrupted by a restart is completed
    // here, before the server answers anything: the running policy stays whatever the file now
    // says, and the next restart picks the published catalogue up.
    economyAdmin?.completePendingStaging();
    const provisioning=new PetProvisioning({accounts:accountService,store,careEconomy});
    const accountWeb=new AccountWebServer({accounts:accountService,provisioning,
      admin:accountAdmin,economyAdmin,operations:desktopTasks?.operations,friends,
      healthView:()=>(typeof server==='undefined'?null:server.health()),
      catalog:priceOverrides??new ItemPriceOverrides({accounts:accountService,database:store.database}),
      port:deploymentEndpoints?.admin.listen.port??(options.has('--account-web-port')?Number(options.get('--account-web-port')):0),
      randomBytes:systemRandomBytes});
    const server=new LocalLoginClientServer({...store.loadServerConfiguration(),webdirProfiles:webdir.profiles,webdirZoneTemplate,
      accountService,store,provisioning,accountWeb,wearableCatalogue,
      deploymentEndpoints,postEntryState,legacyHome,legacyCommunity,legacyCommunityResources:legacyRuntime?.resources,playMenu,careResources,toolbarResources,marketPages,legacyCommunityEntries,desktopGame,gamePort,
      webdirPort,unknownCommandPolicy:options.get('--unknown-command-policy')??'reject'});
    // A disable or a credential reset has to reach the credentials, connections and outstanding
    // adoption handles already in flight, not only the row.
    accountAdmin.tickets=server.ticketIssuer;
    accountAdmin.sessions=server.game;
    accountAdmin.adoptionHandles=server;
    if(legacyRuntime){
      const {LegacyDirectoryServer}=await import('../original-login/legacy-directory-server.js');
      server.legacyDirectory=new LegacyDirectoryServer(legacyRuntime.directory);
    }
    if(options.has('--enable-remote-community')) {
      server.webdir.remoteCommunity=await createRemoteCommunity(server);
    }
    if(options.has('--enable-legacy-resource-http')) {
      const {LegacyHttpServer}=await import('../deployment/legacy-http-server.js');
      server.legacyHttp=new LegacyHttpServer({configuration:deploymentEndpoints,
        resources:server.webdir.remoteCommunity?.site.resources,careResources});
    }
    if(loginTls) {
      const {RemoteLoginServer}=await import('../deployment/remote-login-server.js');
      server.remoteLogin=new RemoteLoginServer({deploymentEndpoints,tls:loginTls,service:server});
    }
    return {store,server};
  }catch(error){store.close();throw error;}
}
