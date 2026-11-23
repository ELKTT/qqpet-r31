using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Windows.Forms;

namespace QQPet.LocalLogin
{
    // CANDIDATE hosting route, honestly labelled: a self-built WinForms host for the runtime
    // copy's own Flash player (flash9d.ocx, the same renderer the client's flashengine carries).
    // This is NOT the game's own browser window and not the A3 DemoUI host; the game-browser
    // route for the adoption movie remains the priority investigation. Nothing is installed or
    // registered: the class is activated by CLSID through the launcher's side-by-side manifest,
    // and this file declares only the OLE plumbing a windowed ActiveX needs to live inside a
    // WinForms control — client site, in-place site, rect management — plus the one event the
    // original adoption movie speaks: FSCommand, whose command value is the movie's own pushed
    // string ("Boy" / "Girl" — not its CallBackB / CallBackG ActionScript function names; static
    // contract in analysis/notes/adopt-swf-static-contract-20260925.md). The IIDs, slot orders
    // and the checked signatures follow oleidl.h exactly; reviews 34-36 corrected the client-site
    // and window IIDs, the in-place and in-place-object slot orders, IOleContainer's inherited
    // IParseDisplayName slot, SetExtent's pointer form and TranslateAccelerator's HRESULT
    // return. (An earlier header here claimed a missing GetDataHere slot: IOleObject has no
    // such member — GetData/GetDataHere/SetData belong to IDataObject — and that claim is
    // withdrawn.)
    internal sealed class FlashHost : Control
    {
        // ShockwaveFlash.ShockwaveFlash coclass and its event source interface.
        private static readonly Guid FlashClassId = new Guid("D27CDB6E-AE6D-11CF-96B8-444553540000");
        private static readonly Guid FlashEventsId = new Guid("D27CDB6C-AE6D-11CF-96B8-444553540000");

        private object flash;
        private IOleObject oleObject;
        private readonly OleSite site = new OleSite();
        private readonly EventSink sink = new EventSink();
        private uint eventCookie;

        internal event Action<string> FsCommand;

        internal void Load(string moviePath)
        {
            if (moviePath == null || !File.Exists(moviePath)) throw new IOException("FLASH_MOVIE_MISSING");
            Type type = Type.GetTypeFromCLSID(FlashClassId, true);
            flash = Activator.CreateInstance(type);
            site.Attach(this);
            sink.Command = command => { Action<string> handler = FsCommand; if (handler != null) handler(command); };
            oleObject = (IOleObject)flash;
            oleObject.SetClientSite(site);
            AdviseEvents();
            // The movie is set through late-bound IDispatch, so no typelib dispid table is
            // embedded here; the runtime resolves Movie/Play exactly the way the scripting host
            // does.
            flash.GetType().InvokeMember("Movie", System.Reflection.BindingFlags.SetProperty, null, flash, new object[] { moviePath });
            flash.GetType().InvokeMember("Play", System.Reflection.BindingFlags.InvokeMethod, null, flash, new object[] { });
            Rect bounds = new Rect { left = 0, top = 0, right = Width, bottom = Height };
            oleObject.DoVerb(-1 /*OLEIVERB_SHOW*/, IntPtr.Zero, site, 0, Handle, ref bounds);
            OnResize(EventArgs.Empty);
        }
        private void AdviseEvents()
        {
            IConnectionPointContainer container = (IConnectionPointContainer)flash;
            IConnectionPoint point;
            Guid eventsId = FlashEventsId;
            container.FindConnectionPoint(ref eventsId, out point);
            int cookie;
            point.Advise(sink, out cookie);
            eventCookie = unchecked((uint)cookie);
        }
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (oleObject == null) return;
            IOleInPlaceObject inPlace = oleObject as IOleInPlaceObject;
            if (inPlace == null) return;
            Rect bounds = new Rect { left = 0, top = 0, right = Width, bottom = Height };
            inPlace.SetObjectRects(ref bounds, ref bounds);
        }
        protected override void Dispose(bool disposing)
        {
            if (flash != null)
            {
                if (eventCookie != 0)
                {
                    try
                    {
                        IConnectionPointContainer container = (IConnectionPointContainer)flash;
                        IConnectionPoint point;
                        Guid eventsId = FlashEventsId;
                        container.FindConnectionPoint(ref eventsId, out point);
                        point.Unadvise(unchecked((int)eventCookie));
                    }
                    catch (COMException) { }
                    eventCookie = 0;
                }
                if (oleObject != null) try { oleObject.Close(1 /*OLECLOSE_NOSAVE*/); } catch (COMException) { }
                oleObject = null;
                IDisposable disposable = flash as IDisposable;
                if (disposable != null) disposable.Dispose();
                flash = null;
            }
            base.Dispose(disposing);
        }

        // The event sink the CLR turns into an IDispatch: only FSCommand (dispid 0x96) is
        // declared, everything else the control fires is dropped by the sink. The command value
        // is handed on verbatim, exactly as the movie pushed it: this layer never rewrites the
        // movie's strings into ActionScript handler names.
        [ComVisible(true)]
        private sealed class EventSink : FlashEvents
        {
            internal Action<string> Command;
            public void FSCommand(string command, string args) { Action<string> handler = Command; if (handler != null) handler(command); }
        }

        private sealed class OleSite : IOleClientSite, IOleInPlaceSite
        {
            private FlashHost owner;
            internal void Attach(FlashHost host) { owner = host; }

            // IOleClientSite
            public void SaveObject() { }
            public void GetMoniker(int dwAssign, int dwWhichMoniker, out object moniker) { moniker = null; }
            public void GetContainer(out IOleContainer container) { container = null; }
            public void ShowObject() { }
            public void OnShowWindow(bool show) { }
            public void RequestNewObjectLayout() { }

            // IOleWindow
            public void GetWindow(out IntPtr hwnd) { hwnd = owner == null || owner.IsDisposed ? IntPtr.Zero : owner.Handle; }
            public void ContextSensitiveHelp(int enter) { }

            // IOleInPlaceSite
            public void CanInPlaceActivate() { } // normal return is S_OK under default HRESULT marshalling
            public void OnInPlaceActivate() { }
            public void OnUIActivate() { }
            public void GetWindowContext(out IOleInPlaceFrame frame, out IOleInPlaceUIWindow document,
                ref Rect posRect, ref Rect clipRect, ref FrameInfo frameInfo)
            {
                frame = null; document = null;
                posRect = new Rect { left = 0, top = 0, right = owner.Width, bottom = owner.Height };
                clipRect = posRect;
                frameInfo.cb = Marshal.SizeOf(typeof(FrameInfo));
                frameInfo.fMDIApp = false;
                frameInfo.hwndFrame = owner.Handle;
                frameInfo.hAccel = IntPtr.Zero;
                frameInfo.cAccelEntries = 0;
            }
            public void Scroll(Extent scrollExtant) { }
            public void OnUIDeactivate(int undoable) { }
            public void OnInPlaceDeactivate() { }
            public void DiscardUndoState() { }
            public void DeactivateAndUndo() { }
            public void OnPosRectChange(ref Rect rect) { }
        }
    }

    // ---- the pieces of the OLE and Flash interfaces this host actually touches ----
    //
    // IIDs and slot orders below are transcribed from the Windows SDK 10.0.26100.0 um/oleidl.h
    // (the same file win32metadata's recompiled header mirrors). Review-34/35 found two wrong
    // IIDs, a hallucinated GetDataHere slot and a missing GetClipboardData slot; the independent
    // contract verifier tools/local-login/verify-oleabi.py re-checks this file against the SDK
    // header at build time so the two cannot drift apart again.

    [ComImport, Guid("D27CDB6C-AE6D-11CF-96B8-444553540000"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
    internal interface FlashEvents
    {
        [DispId(0x96)] void FSCommand(string command, string args);
    }

    [ComVisible(true)]
    internal struct Rect { public int left, top, right, bottom; }

    [ComVisible(true)]
    internal struct Extent
    {
#pragma warning disable 649
        public int cx, cy;
#pragma warning restore 649
    }

    [ComVisible(true)]
    internal struct FrameInfo
    {
        public int cb; public bool fMDIApp; public IntPtr hwndFrame; public IntPtr hAccel; public int cAccelEntries;
    }

    // IOleWindow: {00000114-0000-0000-C000-000000000046}
    [ComImport, Guid("00000114-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleWindow
    {
        void GetWindow(out IntPtr hwnd);
        void ContextSensitiveHelp(int enter);
    }

    // IOleInPlaceSite: {00000119-0000-0000-C000-000000000046}; IOleWindow's two slots, then:
    [ComImport, Guid("00000119-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleInPlaceSite
    {
        void GetWindow(out IntPtr hwnd);
        void ContextSensitiveHelp(int enter);
        void CanInPlaceActivate();
        void OnInPlaceActivate();
        void OnUIActivate();
        void GetWindowContext(out IOleInPlaceFrame frame, out IOleInPlaceUIWindow document,
            ref Rect posRect, ref Rect clipRect, ref FrameInfo frameInfo);
        void Scroll(Extent scrollExtant);
        void OnUIDeactivate(int undoable);
        void OnInPlaceDeactivate();
        void DiscardUndoState();
        void DeactivateAndUndo();
        void OnPosRectChange(ref Rect rect);
    }

    // IOleInPlaceUIWindow: {00000115-0000-0000-C000-000000000046}; IOleWindow's two slots, then:
    [ComImport, Guid("00000115-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleInPlaceUIWindow
    {
        void GetWindow(out IntPtr hwnd);
        void ContextSensitiveHelp(int enter);
        void GetBorder(ref Rect rect);
        void RequestBorderSpace(ref Rect rect);
        void SetBorderSpace(ref Rect rect);
        void SetActiveObject(object activeObject, [MarshalAs(UnmanagedType.LPWStr)] string objName);
    }

    // IOleInPlaceFrame: {00000116-0000-0000-C000-000000000046}; the UIWindow chain, then:
    [ComImport, Guid("00000116-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleInPlaceFrame
    {
        void GetWindow(out IntPtr hwnd);
        void ContextSensitiveHelp(int enter);
        void GetBorder(ref Rect rect);
        void RequestBorderSpace(ref Rect rect);
        void SetBorderSpace(ref Rect rect);
        void SetActiveObject(object activeObject, [MarshalAs(UnmanagedType.LPWStr)] string objName);
        void InsertMenus(IntPtr menuShared, IntPtr menuWidths);
        void SetMenu(IntPtr menuShared, IntPtr menu, IntPtr activeMenu);
        void RemoveMenus(IntPtr menuShared);
        void SetStatusText([MarshalAs(UnmanagedType.LPWStr)] string text);
        void EnableModeless(bool enable);
        [PreserveSig] int TranslateAccelerator(IntPtr msg, int id); // HRESULT return kept as int
    }

    // IOleContainer: {0000011B-0000-0000-C000-000000000046}. It derives from IParseDisplayName,
    // whose ParseDisplayName is slot 3; because a C# interface body only orders the methods it
    // actually declares, the inherited slot is declared here flat so the real slots line up
    // (ParseDisplayName 3, EnumObjects 4, LockContainer 5). A ': IParseDisplayName' clause with
    // only the two own methods would leave EnumObjects on slot 3 — review-37's finding.
    [ComImport, Guid("0000011B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleContainer
    {
        void ParseDisplayName(IntPtr bindContext, [MarshalAs(UnmanagedType.LPWStr)] string displayName,
            IntPtr eaten, out IntPtr moniker);
        void EnumObjects(int flags, out IntPtr enumMoniker);
        void LockContainer(int lockIt);
    }

    // IOleClientSite: {00000118-0000-0000-C000-000000000046}
    [ComImport, Guid("00000118-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleClientSite
    {
        void SaveObject();
        void GetMoniker(int dwAssign, int dwWhichMoniker, out object moniker);
        void GetContainer(out IOleContainer container);
        void ShowObject();
        void OnShowWindow(bool show);
        void RequestNewObjectLayout();
    }

    // IOleObject: {00000112-0000-0000-C000-000000000046}. Note what is NOT here: GetData,
    // GetDataHere and SetData belong to IDataObject; IOleObject carries GetClipboardData in the
    // InitFromData slot region and DoVerb right after it, then EnumVerbs.
    [ComImport, Guid("00000112-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleObject
    {
        void SetClientSite(IOleClientSite site);
        void GetClientSite(out IOleClientSite site);
        void SetHostNames([MarshalAs(UnmanagedType.LPWStr)] string containerApp, [MarshalAs(UnmanagedType.LPWStr)] string containerObj);
        void Close(int saveOption);
        void SetMoniker(int which, IntPtr moniker);
        void GetMoniker(int which, int assign, out IntPtr moniker);
        void InitFromData(IntPtr dataObject, int creation, int reserved);
        void GetClipboardData(int dwReserved, out IntPtr dataObject); // DWORD dwReserved, [out] IDataObject**
        void DoVerb(int verb, IntPtr lpmsg, IOleClientSite activeSite, int index, IntPtr parent, ref Rect posRect);
        void EnumVerbs(out IntPtr enumVerbs);
        void Update();
        void IsUpToDate();
        void GetUserClassID(out Guid clsid);
        void GetUserType(int type, out string userType);
        void SetExtent(int aspect, ref Extent size); // [in] LPCSIZEL: the SDK passes a pointer
        void GetExtent(int aspect, out Extent size);
        void Advise(IAdviseSink sink, out uint cookie);
        void Unadvise(uint cookie);
        void EnumAdvise(out IntPtr enumAdvise);
        void GetMiscStatus(int aspect, out int status);
        void SetColorScheme(IntPtr logpal);
    }

    // IOleInPlaceObject: {00000113-0000-0000-C000-000000000046}; IOleWindow's two slots, then
    // InPlaceDeactivate, UIDeactivate, and only then the rect members.
    [ComImport, Guid("00000113-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleInPlaceObject
    {
        void GetWindow(out IntPtr hwnd);
        void ContextSensitiveHelp(int enter);
        void InPlaceDeactivate();
        void UIDeactivate();
        void SetObjectRects(ref Rect posRect, ref Rect clipRect);
        void ReactivateAndUndo();
    }
}
