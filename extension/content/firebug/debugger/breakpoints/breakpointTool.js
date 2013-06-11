/* See license.txt for terms of usage */

define([
    "firebug/lib/object",
    "firebug/firebug",
    "firebug/lib/trace",
    "firebug/lib/tool",
    "firebug/debugger/breakpoints/breakpointStore",
],
function (Obj, Firebug, FBTrace, Tool, BreakpointStore) {

// ********************************************************************************************* //
// Constants

var TraceError = FBTrace.to("DBG_ERRORS");
var Trace = FBTrace.to("DBG_BREAKPOINTTOOL");

// ********************************************************************************************* //
// Debugger Tool

function BreakpointTool(context)
{
    this.context = context;
}

/**
 * @object BreakpointTool object is automatically instantiated by the framework for each
 * context. Reference to the current context is passed to the constructor. Life cycle
 * of a tool object is the same as for a panel, but tool doesn't have any UI.
 *
 * xxxHonza: It should be derived from Tool base class.
 */
BreakpointTool.prototype = Obj.extend(new Firebug.EventSource(),
/** @lends BreakpointTool */
{
    dispatchName: "breakpointTool",

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Initialization

    attach: function()
    {
        Trace.sysout("breakpointTool.attach; context ID: " + this.context.getId());

        BreakpointStore.addListener(this);
    },

    detach: function()
    {
        Trace.sysout("breakpointTool.detach; context ID: " + this.context.getId());

        BreakpointStore.removeListener(this);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // BreakpointStore Event Listener

    // BreakpointTool (one instance per context) object is handling events coming from
    // BreakpointStore (one instance per Firebug). It consequently performs async operation
    // with the server side (using RDP) and forwarding results to all registered listeners
    // (usually panel objects)

    onAddBreakpoint: function(bp)
    {
        Trace.sysout("breakpointTool.onAddBreakpoint;", bp);

        var self = this;
        this.setBreakpoint(bp.href, bp.lineNo, function(response, bpClient)
        {
            Trace.sysout("breakpointTool.onAddBreakpoint; callback executed", response);

            // Auto-correct shared breakpoint object if necessary and store the original
            // line so, listeners (like e.g. the Script panel) can update the UI.
            var currentLine = bpClient.location.line - 1;
            if (bp.lineNo != currentLine)
            {
                // bpClient deals with 1-based line numbers. Firebug uses 0-based
                // line numbers (indexes)
                bp.params.originLineNo = bp.lineNo;
                bp.lineNo = currentLine;
            }

            // Breakpoint is ready on the server side, let's notify all listeners so,
            // the UI is properly (and asynchronously) updated everywhere.
            self.dispatch("onBreakpointAdded", [self.context, bp]);

            // The info about the original line should not be needed any more.
            delete bp.params.originLineNo;
        });
    },

    onRemoveBreakpoint: function(bp)
    {
        var self = this;
        this.removeBreakpoint(bp.href, bp.lineNo, function(response, bpClient)
        {
            self.dispatch("onBreakpointRemoved", [self.context, bp]);
        });
    },

    onEnableBreakpoint: function(bp)
    {
        var self = this;
        this.enableBreakpoint(bp.href, bp.lineNo, function(response, bpClient)
        {
            self.dispatch("onBreakpointEnabled", [self.context, bp]);
        });
    },

    onDisableBreakpoint: function(bp)
    {
        var self = this;
        this.disableBreakpoint(bp.href, bp.lineNo, function(response, bpClient)
        {
            self.dispatch("onBreakpointDisabled", [self.context, bp]);
        });
    },

    onModifyBreakpoint: function(bp)
    {
        this.dispatch("onBreakpointModified", [this.context, bp]);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Breakpoints

    setBreakpoint: function(url, lineNumber, callback)
    {
        if (!this.context.activeThread)
        {
            TraceError.sysout("BreakpointTool.setBreakpoint; ERROR Can't set BP, no thread.");
            return;
        }

        Trace.sysout("breakpointTool.setBreakpoint; " + url + " (" + lineNumber + ")");

        // Do not create two server side breakpoints at the same line.
        var bpClient = this.getBreakpointClient(url, lineNumber);
        if (bpClient)
        {
            Trace.sysout("breakpointTool.onAddBreakpoint; BP client already exists", bpClient);

            //xxxHonza: the callback expects a packet, it should not.
            if (callback)
                callback({}, bpClient);
            return;
        }

        // Prepare a callback to handle response from the server side.
        var self = this;
        var doSetBreakpoint = function _doSetBreakpoint(response, bpClient)
        {
            var actualLocation = response.actualLocation;

            Trace.sysout("breakpointTool.onSetBreakpoint; " + bpClient.location.url + " (" +
                bpClient.location.line + ")", bpClient);

            // Note that both actualLocation and bpClient.location deal with 1-based
            // line numbers.
            if (actualLocation && actualLocation.line != bpClient.location.line)
            {
                // To be found when it needs removing.
                bpClient.location.line = actualLocation.line;
            }

            // Store breakpoint clients so, we can use the actors to remove breakpoints.
            // xxxFarshid: Shouldn't we save bpClient object only if there is no error?
            // xxxHonza: yes, we probably should.
            // xxxHonza: we also need an error logging
            if (!self.context.breakpointClients)
                self.context.breakpointClients = [];

            // FF 19+: uses same breakpoint client object for a executable line and
            // all non-executable lines above that, so doesn't store breakpoint client
            // objects if there is already one with same actor.
            if (!self.breakpointActorExists(bpClient))
                self.context.breakpointClients.push(bpClient);

            if (callback)
                callback(response, bpClient);
        };

        // Send RDP packet to set a breakpoint on the server side. The callback will be
        // executed as soon as we receive a response.
        return this.context.activeThread.setBreakpoint({
            url: url,
            line: lineNumber + 1
        }, doSetBreakpoint);
    },

    // xxxHonza: execute the callback as soon as all breakpoints are set on the server side.
    setBreakpoints: function(arr, cb)
    {
        var thread = this.context.activeThread;
        if (!thread)
        {
            TraceError.sysout("BreakpointTool.setBreakpoints; Can't set breakpoints " +
                "if there is no active thread");
            return;
        }

        var self = this;
        var doSetBreakpoints = function _doSetBreakpoints(callback)
        {
            Trace.sysout("breakpointTool.doSetBreakpoints; ", arr);

            // Iterate all breakpoints and set them step by step. The thread is
            // paused at this point.
            for (var i=0; i<arr.length; i++)
                self.onAddBreakpoint(arr[i]);
        };

        // If the thread is currently paused, go to set all the breakpoints.
        if (thread.paused)
        {
            doSetBreakpoints();
            return;
        }

        // ... otherwise we need to interupt the thread first.
        thread.interrupt(function(response)
        {
            if (response.error)
            {
                TraceError.sysout("BreakpointTool.setBreakpoints; Can't set breakpoints: " +
                    response.error);
                return;
            }

            // When the thread is interrupted, we can set all the breakpoints.
            doSetBreakpoints(self.resume.bind(self));
        });
    },

    removeBreakpoint: function(url, lineNumber, callback)
    {
        if (!this.context.activeThread)
        {
            TraceError.sysout("BreakpointTool.removeBreakpoint; Can't remove breakpoints.");
            return;
        }

        // Do note remove server-side breakpoint if there are still some client side
        // breakpoint at the line.
        if (BreakpointStore.hasAnyBreakpoint(url, lineNumber))
        {
            // xxxHonza: the callback expects a packet as an argument, it should not.
            if (callback)
                callback({});
            return;
        }

        // We need to get the breakpoint client object for this context. The client
        // knows how to remove the breakpoint on the server side.
        var client = this.removeBreakpointClient(url, lineNumber);
        if (client)
        {
            client.remove(callback);
        }
        else
        {
            TraceError.sysout("debuggerToo.removeBreakpoint; ERROR removing " +
                "non existing breakpoint. " + url + ", " + lineNumber);
        }
    },

    getBreakpointClient: function(url, lineNumber)
    {
        var clients = this.context.breakpointClients;
        if (!clients)
            return;

        for (var i=0; i<clients.length; i++)
        {
            var client = clients[i];
            var loc = client.location;
            if (loc.url == url && (loc.line - 1) == lineNumber)
                return client;
        }
    },

    removeBreakpointClient: function(url, lineNumber)
    {
        var clients = this.context.breakpointClients;
        if (!clients)
            return;

        for (var i=0; i<clients.length; i++)
        {
            var client = clients[i];
            var loc = client.location;
            if (loc.url == url && (loc.line - 1) == lineNumber)
            {
                clients.splice(i, 1);
                return client;
            }
        }
    },

    breakpointActorExists: function(bpClient)
    {
        var clients = this.context.breakpointClients;
        if (!clients)
            return false;

        var client;
        for (var i=0, len = clients.length; i < len; i++)
        {
            client = clients[i];
            if (client.actor === bpClient.actor)
                return true;
        }

        return false;
    },

    enableBreakpoint: function(url, lineNumber, callback)
    {
        // Enable breakpoint means adding it to the server side.
        this.setBreakpoint(url, lineNumber, callback);
    },

    disableBreakpoint: function(url, lineNumber, callback)
    {
        // Disable breakpoint means removing it from the server side.
        this.removeBreakpoint(url, lineNumber, callback);
    },

    isBreakpointDisabled: function(url, lineNumber)
    {
        //return JSDebugger.fbs.isBreakpointDisabled(url, lineNumber);
    },

    getBreakpointCondition: function(url, lineNumber)
    {
        //return JSDebugger.fbs.getBreakpointCondition(url, lineNumber);
    },
});

// ********************************************************************************************* //
// Registration

Firebug.registerTool("breakpoint", BreakpointTool);

return BreakpointTool;

// ********************************************************************************************* //
});
