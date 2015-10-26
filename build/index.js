"format amd";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;

      if (typeof name == 'object') {
        for (var p in name)
          exports[p] = name[p];
      }
      else {
        exports[name] = value;
      }

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if (typeof exports == 'object' || typeof exports == 'function') {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(['0'], [], function($__System) {

(function(__global) {
  var loader = $__System;
  var hasOwnProperty = Object.prototype.hasOwnProperty;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function readMemberExpression(p, value) {
    var pParts = p.split('.');
    while (pParts.length)
      value = value[pParts.shift()];
    return value;
  }

  // bare minimum ignores for IE8
  var ignoredGlobalProps = ['_g', 'sessionStorage', 'localStorage', 'clipboardData', 'frames', 'external', 'mozAnimationStartTime', 'webkitStorageInfo', 'webkitIndexedDB'];

  var globalSnapshot;

  function forEachGlobal(callback) {
    if (Object.keys)
      Object.keys(__global).forEach(callback);
    else
      for (var g in __global) {
        if (!hasOwnProperty.call(__global, g))
          continue;
        callback(g);
      }
  }

  function forEachGlobalValue(callback) {
    forEachGlobal(function(globalName) {
      if (indexOf.call(ignoredGlobalProps, globalName) != -1)
        return;
      try {
        var value = __global[globalName];
      }
      catch (e) {
        ignoredGlobalProps.push(globalName);
      }
      callback(globalName, value);
    });
  }

  loader.set('@@global-helpers', loader.newModule({
    prepareGlobal: function(moduleName, exportName, globals) {
      // disable module detection
      var curDefine = __global.define;
       
      __global.define = undefined;
      __global.exports = undefined;
      if (__global.module && __global.module.exports)
        __global.module = undefined;

      // set globals
      var oldGlobals;
      if (globals) {
        oldGlobals = {};
        for (var g in globals) {
          oldGlobals[g] = globals[g];
          __global[g] = globals[g];
        }
      }

      // store a complete copy of the global object in order to detect changes
      if (!exportName) {
        globalSnapshot = {};

        forEachGlobalValue(function(name, value) {
          globalSnapshot[name] = value;
        });
      }

      // return function to retrieve global
      return function() {
        var globalValue;

        if (exportName) {
          globalValue = readMemberExpression(exportName, __global);
        }
        else {
          var singleGlobal;
          var multipleExports;
          var exports = {};

          forEachGlobalValue(function(name, value) {
            if (globalSnapshot[name] === value)
              return;
            if (typeof value == 'undefined')
              return;
            exports[name] = value;

            if (typeof singleGlobal != 'undefined') {
              if (!multipleExports && singleGlobal !== value)
                multipleExports = true;
            }
            else {
              singleGlobal = value;
            }
          });
          globalValue = multipleExports ? exports : singleGlobal;
        }

        // revert globals
        if (oldGlobals) {
          for (var g in oldGlobals)
            __global[g] = oldGlobals[g];
        }
        __global.define = curDefine;

        return globalValue;
      };
    }
  }));

})(typeof self != 'undefined' ? self : global);

(function(__global) {
  var loader = $__System;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var commentRegEx = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg;
  var cjsRequirePre = "(?:^|[^$_a-zA-Z\\xA0-\\uFFFF.])";
  var cjsRequirePost = "\\s*\\(\\s*(\"([^\"]+)\"|'([^']+)')\\s*\\)";
  var fnBracketRegEx = /\(([^\)]*)\)/;
  var wsRegEx = /^\s+|\s+$/g;
  
  var requireRegExs = {};

  function getCJSDeps(source, requireIndex) {

    // remove comments
    source = source.replace(commentRegEx, '');

    // determine the require alias
    var params = source.match(fnBracketRegEx);
    var requireAlias = (params[1].split(',')[requireIndex] || 'require').replace(wsRegEx, '');

    // find or generate the regex for this requireAlias
    var requireRegEx = requireRegExs[requireAlias] || (requireRegExs[requireAlias] = new RegExp(cjsRequirePre + requireAlias + cjsRequirePost, 'g'));

    requireRegEx.lastIndex = 0;

    var deps = [];

    var match;
    while (match = requireRegEx.exec(source))
      deps.push(match[2] || match[3]);

    return deps;
  }

  /*
    AMD-compatible require
    To copy RequireJS, set window.require = window.requirejs = loader.amdRequire
  */
  function require(names, callback, errback, referer) {
    // in amd, first arg can be a config object... we just ignore
    if (typeof names == 'object' && !(names instanceof Array))
      return require.apply(null, Array.prototype.splice.call(arguments, 1, arguments.length - 1));

    // amd require
    if (typeof names == 'string' && typeof callback == 'function')
      names = [names];
    if (names instanceof Array) {
      var dynamicRequires = [];
      for (var i = 0; i < names.length; i++)
        dynamicRequires.push(loader['import'](names[i], referer));
      Promise.all(dynamicRequires).then(function(modules) {
        if (callback)
          callback.apply(null, modules);
      }, errback);
    }

    // commonjs require
    else if (typeof names == 'string') {
      var module = loader.get(names);
      return module.__useDefault ? module['default'] : module;
    }

    else
      throw new TypeError('Invalid require');
  }

  function define(name, deps, factory) {
    if (typeof name != 'string') {
      factory = deps;
      deps = name;
      name = null;
    }
    if (!(deps instanceof Array)) {
      factory = deps;
      deps = ['require', 'exports', 'module'].splice(0, factory.length);
    }

    if (typeof factory != 'function')
      factory = (function(factory) {
        return function() { return factory; }
      })(factory);

    // in IE8, a trailing comma becomes a trailing undefined entry
    if (deps[deps.length - 1] === undefined)
      deps.pop();

    // remove system dependencies
    var requireIndex, exportsIndex, moduleIndex;
    
    if ((requireIndex = indexOf.call(deps, 'require')) != -1) {
      
      deps.splice(requireIndex, 1);

      // only trace cjs requires for non-named
      // named defines assume the trace has already been done
      if (!name)
        deps = deps.concat(getCJSDeps(factory.toString(), requireIndex));
    }

    if ((exportsIndex = indexOf.call(deps, 'exports')) != -1)
      deps.splice(exportsIndex, 1);
    
    if ((moduleIndex = indexOf.call(deps, 'module')) != -1)
      deps.splice(moduleIndex, 1);

    var define = {
      name: name,
      deps: deps,
      execute: function(req, exports, module) {

        var depValues = [];
        for (var i = 0; i < deps.length; i++)
          depValues.push(req(deps[i]));

        module.uri = module.id;

        module.config = function() {};

        // add back in system dependencies
        if (moduleIndex != -1)
          depValues.splice(moduleIndex, 0, module);
        
        if (exportsIndex != -1)
          depValues.splice(exportsIndex, 0, exports);
        
        if (requireIndex != -1) 
          depValues.splice(requireIndex, 0, function(names, callback, errback) {
            if (typeof names == 'string' && typeof callback != 'function')
              return req(names);
            return require.call(loader, names, callback, errback, module.id);
          });

        // set global require to AMD require
        var curRequire = __global.require;
        __global.require = require;

        var output = factory.apply(exportsIndex == -1 ? __global : exports, depValues);

        __global.require = curRequire;

        if (typeof output == 'undefined' && module)
          output = module.exports;

        if (typeof output != 'undefined')
          return output;
      }
    };

    // anonymous define
    if (!name) {
      // already defined anonymously -> throw
      if (lastModule.anonDefine)
        throw new TypeError('Multiple defines for anonymous module');
      lastModule.anonDefine = define;
    }
    // named define
    else {
      // if we don't have any other defines,
      // then let this be an anonymous define
      // this is just to support single modules of the form:
      // define('jquery')
      // still loading anonymously
      // because it is done widely enough to be useful
      if (!lastModule.anonDefine && !lastModule.isBundle) {
        lastModule.anonDefine = define;
      }
      // otherwise its a bundle only
      else {
        // if there is an anonDefine already (we thought it could have had a single named define)
        // then we define it now
        // this is to avoid defining named defines when they are actually anonymous
        if (lastModule.anonDefine && lastModule.anonDefine.name)
          loader.registerDynamic(lastModule.anonDefine.name, lastModule.anonDefine.deps, false, lastModule.anonDefine.execute);

        lastModule.anonDefine = null;
      }

      // note this is now a bundle
      lastModule.isBundle = true;

      // define the module through the register registry
      loader.registerDynamic(name, define.deps, false, define.execute);
    }
  }
  define.amd = {};

  // adds define as a global (potentially just temporarily)
  function createDefine(loader) {
    lastModule.anonDefine = null;
    lastModule.isBundle = false;

    // ensure no NodeJS environment detection
    var oldModule = __global.module;
    var oldExports = __global.exports;
    var oldDefine = __global.define;

    __global.module = undefined;
    __global.exports = undefined;
    __global.define = define;

    return function() {
      __global.define = oldDefine;
      __global.module = oldModule;
      __global.exports = oldExports;
    };
  }

  var lastModule = {
    isBundle: false,
    anonDefine: null
  };

  loader.set('@@amd-helpers', loader.newModule({
    createDefine: createDefine,
    require: require,
    define: define,
    lastModule: lastModule
  }));
  loader.amdDefine = define;
  loader.amdRequire = require;
})(typeof self != 'undefined' ? self : global);
"bundle";
(function() {
var _removeDefine = $__System.get("@@amd-helpers").createDefine();
'format amd';
define("0", ["1", "2", "3"], function($, palindrome, semantic) {
  'use strict';
  $(".sendButton").click(function() {
    var testString = $(".input-field").val();
    palindrome.testPalyndrom(testString);
    return false;
  });
  $(".sendButton").click(function() {
    var testString = $(".input-field").val();
    palindrome.testPalyndrom(testString);
    return false;
  });
});

_removeDefine();
})();
(function() {
var _removeDefine = $__System.get("@@amd-helpers").createDefine();
'format amd';
define("2", [], function() {
  'use strict';
  var Palindrome = {
    testPalyndrom: testPalyndrom,
    checkIfPalyndrom: checkIfPalyndrom
  };
  return Palindrome;
  function testPalyndrom(testString) {
    var i,
        j;
    for (i = 0; i < testString.length; i++) {
      for (j = i + 2; j < testString.length; j++) {
        checkIfPalyndrom(testString.substring(i, j + 1));
      }
    }
  }
  ;
  function checkIfPalyndrom(str) {
    var i = 0,
        j = str.length - 1;
    while ((str[i] === str[j]) && (i !== j)) {
      i++;
      j--;
    }
    if (i === j) {
      console.log("+++", str);
      return str;
    }
    return false;
  }
});

_removeDefine();
})();
$__System.registerDynamic("3", [], false, function(__require, __exports, __module) {
  var _retrieveGlobal = $__System.get("@@global-helpers").prepareGlobal(__module.id, null, null);
  (function() {
    ;
    (function($, window, document, undefined) {
      $.site = $.fn.site = function(parameters) {
        var time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.site.settings, parameters) : $.extend({}, $.site.settings),
            namespace = settings.namespace,
            error = settings.error,
            eventNamespace = '.' + namespace,
            moduleNamespace = 'module-' + namespace,
            $document = $(document),
            $module = $document,
            element = this,
            instance = $module.data(moduleNamespace),
            module,
            returnedValue;
        ;
        module = {
          initialize: function() {
            module.instantiate();
          },
          instantiate: function() {
            module.verbose('Storing instance of site', module);
            instance = module;
            $module.data(moduleNamespace, module);
            ;
          },
          normalize: function() {
            module.fix.console();
            module.fix.requestAnimationFrame();
          },
          fix: {
            console: function() {
              module.debug('Normalizing window.console');
              if (console === undefined || console.log === undefined) {
                module.verbose('Console not available, normalizing events');
                module.disable.console();
              }
              if (typeof console.group == 'undefined' || typeof console.groupEnd == 'undefined' || typeof console.groupCollapsed == 'undefined') {
                module.verbose('Console group not available, normalizing events');
                window.console.group = function() {};
                window.console.groupEnd = function() {};
                window.console.groupCollapsed = function() {};
              }
              if (typeof console.markTimeline == 'undefined') {
                module.verbose('Mark timeline not available, normalizing events');
                window.console.markTimeline = function() {};
              }
            },
            consoleClear: function() {
              module.debug('Disabling programmatic console clearing');
              window.console.clear = function() {};
            },
            requestAnimationFrame: function() {
              module.debug('Normalizing requestAnimationFrame');
              if (window.requestAnimationFrame === undefined) {
                module.debug('RequestAnimationFrame not available, normalizing event');
                window.requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
                  setTimeout(callback, 0);
                };
                ;
              }
            }
          },
          moduleExists: function(name) {
            return ($.fn[name] !== undefined && $.fn[name].settings !== undefined);
          },
          enabled: {modules: function(modules) {
              var enabledModules = [];
              ;
              modules = modules || settings.modules;
              $.each(modules, function(index, name) {
                if (module.moduleExists(name)) {
                  enabledModules.push(name);
                }
              });
              return enabledModules;
            }},
          disabled: {modules: function(modules) {
              var disabledModules = [];
              ;
              modules = modules || settings.modules;
              $.each(modules, function(index, name) {
                if (!module.moduleExists(name)) {
                  disabledModules.push(name);
                }
              });
              return disabledModules;
            }},
          change: {
            setting: function(setting, value, modules, modifyExisting) {
              modules = (typeof modules === 'string') ? (modules === 'all') ? settings.modules : [modules] : modules || settings.modules;
              ;
              modifyExisting = (modifyExisting !== undefined) ? modifyExisting : true;
              ;
              $.each(modules, function(index, name) {
                var namespace = (module.moduleExists(name)) ? $.fn[name].settings.namespace || false : true,
                    $existingModules;
                ;
                if (module.moduleExists(name)) {
                  module.verbose('Changing default setting', setting, value, name);
                  $.fn[name].settings[setting] = value;
                  if (modifyExisting && namespace) {
                    $existingModules = $(':data(module-' + namespace + ')');
                    if ($existingModules.length > 0) {
                      module.verbose('Modifying existing settings', $existingModules);
                      $existingModules[name]('setting', setting, value);
                    }
                  }
                }
              });
            },
            settings: function(newSettings, modules, modifyExisting) {
              modules = (typeof modules === 'string') ? [modules] : modules || settings.modules;
              ;
              modifyExisting = (modifyExisting !== undefined) ? modifyExisting : true;
              ;
              $.each(modules, function(index, name) {
                var $existingModules;
                ;
                if (module.moduleExists(name)) {
                  module.verbose('Changing default setting', newSettings, name);
                  $.extend(true, $.fn[name].settings, newSettings);
                  if (modifyExisting && namespace) {
                    $existingModules = $(':data(module-' + namespace + ')');
                    if ($existingModules.length > 0) {
                      module.verbose('Modifying existing settings', $existingModules);
                      $existingModules[name]('setting', newSettings);
                    }
                  }
                }
              });
            }
          },
          enable: {
            console: function() {
              module.console(true);
            },
            debug: function(modules, modifyExisting) {
              modules = modules || settings.modules;
              module.debug('Enabling debug for modules', modules);
              module.change.setting('debug', true, modules, modifyExisting);
            },
            verbose: function(modules, modifyExisting) {
              modules = modules || settings.modules;
              module.debug('Enabling verbose debug for modules', modules);
              module.change.setting('verbose', true, modules, modifyExisting);
            }
          },
          disable: {
            console: function() {
              module.console(false);
            },
            debug: function(modules, modifyExisting) {
              modules = modules || settings.modules;
              module.debug('Disabling debug for modules', modules);
              module.change.setting('debug', false, modules, modifyExisting);
            },
            verbose: function(modules, modifyExisting) {
              modules = modules || settings.modules;
              module.debug('Disabling verbose debug for modules', modules);
              module.change.setting('verbose', false, modules, modifyExisting);
            }
          },
          console: function(enable) {
            if (enable) {
              if (instance.cache.console === undefined) {
                module.error(error.console);
                return;
              }
              module.debug('Restoring console function');
              window.console = instance.cache.console;
            } else {
              module.debug('Disabling console function');
              instance.cache.console = window.console;
              window.console = {
                clear: function() {},
                error: function() {},
                group: function() {},
                groupCollapsed: function() {},
                groupEnd: function() {},
                info: function() {},
                log: function() {},
                markTimeline: function() {},
                warn: function() {}
              };
            }
          },
          destroy: function() {
            module.verbose('Destroying previous site for', $module);
            $module.removeData(moduleNamespace);
            ;
          },
          cache: {},
          setting: function(name, value) {
            if ($.isPlainObject(name)) {
              $.extend(true, settings, name);
            } else if (value !== undefined) {
              settings[name] = value;
            } else {
              return settings[name];
            }
          },
          internal: function(name, value) {
            if ($.isPlainObject(name)) {
              $.extend(true, module, name);
            } else if (value !== undefined) {
              module[name] = value;
            } else {
              return module[name];
            }
          },
          debug: function() {
            if (settings.debug) {
              if (settings.performance) {
                module.performance.log(arguments);
              } else {
                module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                module.debug.apply(console, arguments);
              }
            }
          },
          verbose: function() {
            if (settings.verbose && settings.debug) {
              if (settings.performance) {
                module.performance.log(arguments);
              } else {
                module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                module.verbose.apply(console, arguments);
              }
            }
          },
          error: function() {
            module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
            module.error.apply(console, arguments);
          },
          performance: {
            log: function(message) {
              var currentTime,
                  executionTime,
                  previousTime;
              ;
              if (settings.performance) {
                currentTime = new Date().getTime();
                previousTime = time || currentTime;
                executionTime = currentTime - previousTime;
                time = currentTime;
                performance.push({
                  'Element': element,
                  'Name': message[0],
                  'Arguments': [].slice.call(message, 1) || '',
                  'Execution Time': executionTime
                });
              }
              clearTimeout(module.performance.timer);
              module.performance.timer = setTimeout(module.performance.display, 500);
            },
            display: function() {
              var title = settings.name + ':',
                  totalTime = 0;
              ;
              time = false;
              clearTimeout(module.performance.timer);
              $.each(performance, function(index, data) {
                totalTime += data['Execution Time'];
              });
              title += ' ' + totalTime + 'ms';
              if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                console.groupCollapsed(title);
                if (console.table) {
                  console.table(performance);
                } else {
                  $.each(performance, function(index, data) {
                    console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                  });
                }
                console.groupEnd();
              }
              performance = [];
            }
          },
          invoke: function(query, passedArguments, context) {
            var object = instance,
                maxDepth,
                found,
                response;
            ;
            passedArguments = passedArguments || queryArguments;
            context = element || context;
            if (typeof query == 'string' && object !== undefined) {
              query = query.split(/[\. ]/);
              maxDepth = query.length - 1;
              $.each(query, function(depth, value) {
                var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                ;
                if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                  object = object[camelCaseValue];
                } else if (object[camelCaseValue] !== undefined) {
                  found = object[camelCaseValue];
                  return false;
                } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                  object = object[value];
                } else if (object[value] !== undefined) {
                  found = object[value];
                  return false;
                } else {
                  module.error(error.method, query);
                  return false;
                }
              });
            }
            if ($.isFunction(found)) {
              response = found.apply(context, passedArguments);
            } else if (found !== undefined) {
              response = found;
            }
            if ($.isArray(returnedValue)) {
              returnedValue.push(response);
            } else if (returnedValue !== undefined) {
              returnedValue = [returnedValue, response];
            } else if (response !== undefined) {
              returnedValue = response;
            }
            return found;
          }
        };
        if (methodInvoked) {
          if (instance === undefined) {
            module.initialize();
          }
          module.invoke(query);
        } else {
          if (instance !== undefined) {
            module.destroy();
          }
          module.initialize();
        }
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.site.settings = {
        name: 'Site',
        namespace: 'site',
        error: {
          console: 'Console cannot be restored, most likely it was overwritten outside of module',
          method: 'The method you called is not defined.'
        },
        debug: false,
        verbose: false,
        performance: true,
        modules: ['accordion', 'api', 'checkbox', 'dimmer', 'dropdown', 'embed', 'form', 'modal', 'nag', 'popup', 'rating', 'shape', 'sidebar', 'state', 'sticky', 'tab', 'transition', 'visit', 'visibility'],
        siteNamespace: 'site',
        namespaceStub: {
          cache: {},
          config: {},
          sections: {},
          section: {},
          utilities: {}
        }
      };
      $.extend($.expr[":"], {data: ($.expr.createPseudo) ? $.expr.createPseudo(function(dataName) {
          return function(elem) {
            return !!$.data(elem, dataName);
          };
        }) : function(elem, i, match) {
          return !!$.data(elem, match[3]);
        }});
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.form = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            legacyParameters = arguments[1],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var $module = $(this),
              element = this,
              formErrors = [],
              keyHeldDown = false,
              $field,
              $group,
              $message,
              $prompt,
              $submit,
              $clear,
              $reset,
              settings,
              validation,
              metadata,
              selector,
              className,
              error,
              namespace,
              moduleNamespace,
              eventNamespace,
              instance,
              module;
          ;
          module = {
            initialize: function() {
              module.get.settings();
              if (methodInvoked) {
                if (instance === undefined) {
                  module.instantiate();
                }
                module.invoke(query);
              } else {
                module.verbose('Initializing form validation', $module, settings);
                module.bindEvents();
                module.set.defaults();
                module.instantiate();
              }
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous module', instance);
              module.removeEvents();
              $module.removeData(moduleNamespace);
              ;
            },
            refresh: function() {
              module.verbose('Refreshing selector cache');
              $field = $module.find(selector.field);
              $group = $module.find(selector.group);
              $message = $module.find(selector.message);
              $prompt = $module.find(selector.prompt);
              $submit = $module.find(selector.submit);
              $clear = $module.find(selector.clear);
              $reset = $module.find(selector.reset);
            },
            submit: function() {
              module.verbose('Submitting form', $module);
              $module.submit();
              ;
            },
            attachEvents: function(selector, action) {
              action = action || 'submit';
              $(selector).on('click' + eventNamespace, function(event) {
                module[action]();
                event.preventDefault();
              });
              ;
            },
            bindEvents: function() {
              module.verbose('Attaching form events');
              $module.on('submit' + eventNamespace, module.validate.form).on('blur' + eventNamespace, selector.field, module.event.field.blur).on('click' + eventNamespace, selector.submit, module.submit).on('click' + eventNamespace, selector.reset, module.reset).on('click' + eventNamespace, selector.clear, module.clear);
              ;
              if (settings.keyboardShortcuts) {
                $module.on('keydown' + eventNamespace, selector.field, module.event.field.keydown);
                ;
              }
              $field.each(function() {
                var $input = $(this),
                    type = $input.prop('type'),
                    inputEvent = module.get.changeEvent(type, $input);
                ;
                $(this).on(inputEvent + eventNamespace, module.event.field.change);
                ;
              });
              ;
            },
            clear: function() {
              $field.each(function() {
                var $field = $(this),
                    $element = $field.parent(),
                    $fieldGroup = $field.closest($group),
                    $prompt = $fieldGroup.find(selector.prompt),
                    defaultValue = $field.data(metadata.defaultValue) || '',
                    isCheckbox = $element.is(selector.uiCheckbox),
                    isDropdown = $element.is(selector.uiDropdown),
                    isErrored = $fieldGroup.hasClass(className.error);
                ;
                if (isErrored) {
                  module.verbose('Resetting error on field', $fieldGroup);
                  $fieldGroup.removeClass(className.error);
                  $prompt.remove();
                }
                if (isDropdown) {
                  module.verbose('Resetting dropdown value', $element, defaultValue);
                  $element.dropdown('clear');
                } else if (isCheckbox) {
                  $field.prop('checked', false);
                } else {
                  module.verbose('Resetting field value', $field, defaultValue);
                  $field.val('');
                }
              });
              ;
            },
            reset: function() {
              $field.each(function() {
                var $field = $(this),
                    $element = $field.parent(),
                    $fieldGroup = $field.closest($group),
                    $prompt = $fieldGroup.find(selector.prompt),
                    defaultValue = $field.data(metadata.defaultValue),
                    isCheckbox = $element.is(selector.uiCheckbox),
                    isDropdown = $element.is(selector.uiDropdown),
                    isErrored = $fieldGroup.hasClass(className.error);
                ;
                if (defaultValue === undefined) {
                  return;
                }
                if (isErrored) {
                  module.verbose('Resetting error on field', $fieldGroup);
                  $fieldGroup.removeClass(className.error);
                  $prompt.remove();
                }
                if (isDropdown) {
                  module.verbose('Resetting dropdown value', $element, defaultValue);
                  $element.dropdown('restore defaults');
                } else if (isCheckbox) {
                  module.verbose('Resetting checkbox value', $element, defaultValue);
                  $field.prop('checked', defaultValue);
                } else {
                  module.verbose('Resetting field value', $field, defaultValue);
                  $field.val(defaultValue);
                }
              });
              ;
            },
            is: {
              bracketedRule: function(rule) {
                return (rule.type && rule.type.match(settings.regExp.bracket));
              },
              valid: function() {
                var allValid = true;
                ;
                module.verbose('Checking if form is valid');
                $.each(validation, function(fieldName, field) {
                  if (!(module.validate.field(field, fieldName))) {
                    allValid = false;
                  }
                });
                return allValid;
              }
            },
            removeEvents: function() {
              $module.off(eventNamespace);
              ;
              $field.off(eventNamespace);
              ;
              $submit.off(eventNamespace);
              ;
              $field.off(eventNamespace);
              ;
            },
            event: {field: {
                keydown: function(event) {
                  var $field = $(this),
                      key = event.which,
                      keyCode = {
                        enter: 13,
                        escape: 27
                      };
                  ;
                  if (key == keyCode.escape) {
                    module.verbose('Escape key pressed blurring field');
                    $field.blur();
                    ;
                  }
                  if (!event.ctrlKey && key == keyCode.enter && $field.is(selector.input) && $field.not(selector.checkbox).length > 0) {
                    if (!keyHeldDown) {
                      $field.one('keyup' + eventNamespace, module.event.field.keyup);
                      ;
                      module.submit();
                      module.debug('Enter pressed on input submitting form');
                    }
                    keyHeldDown = true;
                  }
                },
                keyup: function() {
                  keyHeldDown = false;
                },
                blur: function(event) {
                  var $field = $(this),
                      $fieldGroup = $field.closest($group),
                      validationRules = module.get.validation($field);
                  ;
                  if ($fieldGroup.hasClass(className.error)) {
                    module.debug('Revalidating field', $field, validationRules);
                    module.validate.form.call(module, event, true);
                  } else if (settings.on == 'blur' || settings.on == 'change') {
                    module.validate.field(validationRules);
                  }
                },
                change: function(event) {
                  var $field = $(this),
                      $fieldGroup = $field.closest($group);
                  ;
                  if (settings.on == 'change' || ($fieldGroup.hasClass(className.error) && settings.revalidate)) {
                    clearTimeout(module.timer);
                    module.timer = setTimeout(function() {
                      module.debug('Revalidating field', $field, module.get.validation($field));
                      module.validate.form.call(module, event, true);
                    }, settings.delay);
                  }
                }
              }},
            get: {
              ancillaryValue: function(rule) {
                if (!rule.type || !module.is.bracketedRule(rule)) {
                  return false;
                }
                return rule.type.match(settings.regExp.bracket)[1] + '';
              },
              ruleName: function(rule) {
                if (module.is.bracketedRule(rule)) {
                  return rule.type.replace(rule.type.match(settings.regExp.bracket)[0], '');
                }
                return rule.type;
              },
              changeEvent: function(type, $input) {
                if (type == 'checkbox' || type == 'radio' || type == 'hidden' || $input.is('select')) {
                  return 'change';
                } else {
                  return module.get.inputEvent();
                }
              },
              inputEvent: function() {
                return (document.createElement('input').oninput !== undefined) ? 'input' : (document.createElement('input').onpropertychange !== undefined) ? 'propertychange' : 'keyup';
                ;
              },
              prompt: function(rule, field) {
                var ruleName = module.get.ruleName(rule),
                    ancillary = module.get.ancillaryValue(rule),
                    prompt = rule.prompt || settings.prompt[ruleName] || settings.text.unspecifiedRule,
                    requiresValue = (prompt.search('{value}') !== -1),
                    requiresName = (prompt.search('{name}') !== -1),
                    $label,
                    $field,
                    name;
                ;
                if (requiresName || requiresValue) {
                  $field = module.get.field(field.identifier);
                }
                if (requiresValue) {
                  prompt = prompt.replace('{value}', $field.val());
                }
                if (requiresName) {
                  $label = $field.closest(selector.group).find('label').eq(0);
                  name = ($label.size() == 1) ? $label.text() : $field.prop('placeholder') || settings.text.unspecifiedField;
                  ;
                  prompt = prompt.replace('{name}', name);
                }
                prompt = prompt.replace('{identifier}', field.identifier);
                prompt = prompt.replace('{ruleValue}', ancillary);
                if (!rule.prompt) {
                  module.verbose('Using default validation prompt for type', prompt, ruleName);
                }
                return prompt;
              },
              settings: function() {
                if ($.isPlainObject(parameters)) {
                  var keys = Object.keys(parameters),
                      isLegacySettings = (keys.length > 0) ? (parameters[keys[0]].identifier !== undefined && parameters[keys[0]].rules !== undefined) : false,
                      ruleKeys;
                  ;
                  if (isLegacySettings) {
                    settings = $.extend(true, {}, $.fn.form.settings, legacyParameters);
                    validation = $.extend({}, $.fn.form.settings.defaults, parameters);
                    module.error(settings.error.oldSyntax, element);
                    module.verbose('Extending settings from legacy parameters', validation, settings);
                  } else {
                    if (parameters.fields) {
                      ruleKeys = Object.keys(parameters.fields);
                      if (typeof parameters.fields[ruleKeys[0]] == 'string' || $.isArray(parameters.fields[ruleKeys[0]])) {
                        $.each(parameters.fields, function(name, rules) {
                          if (typeof rules == 'string') {
                            rules = [rules];
                          }
                          parameters.fields[name] = {rules: []};
                          $.each(rules, function(index, rule) {
                            parameters.fields[name].rules.push({type: rule});
                          });
                        });
                      }
                    }
                    settings = $.extend(true, {}, $.fn.form.settings, parameters);
                    validation = $.extend({}, $.fn.form.settings.defaults, settings.fields);
                    module.verbose('Extending settings', validation, settings);
                  }
                } else {
                  settings = $.fn.form.settings;
                  validation = $.fn.form.settings.defaults;
                  module.verbose('Using default form validation', validation, settings);
                }
                namespace = settings.namespace;
                metadata = settings.metadata;
                selector = settings.selector;
                className = settings.className;
                error = settings.error;
                moduleNamespace = 'module-' + namespace;
                eventNamespace = '.' + namespace;
                instance = $module.data(moduleNamespace);
                module.refresh();
              },
              field: function(identifier) {
                module.verbose('Finding field with identifier', identifier);
                if ($field.filter('#' + identifier).length > 0) {
                  return $field.filter('#' + identifier);
                } else if ($field.filter('[name="' + identifier + '"]').length > 0) {
                  return $field.filter('[name="' + identifier + '"]');
                } else if ($field.filter('[name="' + identifier + '[]"]').length > 0) {
                  return $field.filter('[name="' + identifier + '[]"]');
                } else if ($field.filter('[data-' + metadata.validate + '="' + identifier + '"]').length > 0) {
                  return $field.filter('[data-' + metadata.validate + '="' + identifier + '"]');
                }
                return $('<input/>');
              },
              fields: function(fields) {
                var $fields = $();
                ;
                $.each(fields, function(index, name) {
                  $fields = $fields.add(module.get.field(name));
                });
                return $fields;
              },
              validation: function($field) {
                var fieldValidation,
                    identifier;
                ;
                if (!validation) {
                  return false;
                }
                $.each(validation, function(fieldName, field) {
                  identifier = field.identifier || fieldName;
                  if (module.get.field(identifier)[0] == $field[0]) {
                    field.identifier = identifier;
                    fieldValidation = field;
                  }
                });
                return fieldValidation || false;
              },
              value: function(field) {
                var fields = [],
                    results;
                ;
                fields.push(field);
                results = module.get.values.call(element, fields);
                return results[field];
              },
              values: function(fields) {
                var $fields = $.isArray(fields) ? module.get.fields(fields) : $field,
                    values = {};
                ;
                $fields.each(function(index, field) {
                  var $field = $(field),
                      type = $field.prop('type'),
                      name = $field.prop('name'),
                      value = $field.val(),
                      isCheckbox = $field.is(selector.checkbox),
                      isRadio = $field.is(selector.radio),
                      isMultiple = (name.indexOf('[]') !== -1),
                      isChecked = (isCheckbox) ? $field.is(':checked') : false;
                  ;
                  if (name) {
                    if (isMultiple) {
                      name = name.replace('[]', '');
                      if (!values[name]) {
                        values[name] = [];
                      }
                      if (isCheckbox) {
                        if (isChecked) {
                          values[name].push(value || true);
                        } else {
                          values[name].push(false);
                        }
                      } else {
                        values[name].push(value);
                      }
                    } else {
                      if (isRadio) {
                        if (isChecked) {
                          values[name] = value;
                        }
                      } else if (isCheckbox) {
                        if (isChecked) {
                          values[name] = value || true;
                        } else {
                          values[name] = false;
                        }
                      } else {
                        values[name] = value;
                      }
                    }
                  }
                });
                return values;
              }
            },
            has: {field: function(identifier) {
                module.verbose('Checking for existence of a field with identifier', identifier);
                if (typeof identifier !== 'string') {
                  module.error(error.identifier, identifier);
                }
                if ($field.filter('#' + identifier).length > 0) {
                  return true;
                } else if ($field.filter('[name="' + identifier + '"]').length > 0) {
                  return true;
                } else if ($field.filter('[data-' + metadata.validate + '="' + identifier + '"]').length > 0) {
                  return true;
                }
                return false;
              }},
            add: {
              prompt: function(identifier, errors) {
                var $field = module.get.field(identifier),
                    $fieldGroup = $field.closest($group),
                    $prompt = $fieldGroup.children(selector.prompt),
                    promptExists = ($prompt.length !== 0);
                ;
                errors = (typeof errors == 'string') ? [errors] : errors;
                ;
                module.verbose('Adding field error state', identifier);
                $fieldGroup.addClass(className.error);
                ;
                if (settings.inline) {
                  if (!promptExists) {
                    $prompt = settings.templates.prompt(errors);
                    $prompt.appendTo($fieldGroup);
                    ;
                  }
                  $prompt.html(errors[0]);
                  ;
                  if (!promptExists) {
                    if (settings.transition && $.fn.transition !== undefined && $module.transition('is supported')) {
                      module.verbose('Displaying error with css transition', settings.transition);
                      $prompt.transition(settings.transition + ' in', settings.duration);
                    } else {
                      module.verbose('Displaying error with fallback javascript animation');
                      $prompt.fadeIn(settings.duration);
                      ;
                    }
                  } else {
                    module.verbose('Inline errors are disabled, no inline error added', identifier);
                  }
                }
              },
              errors: function(errors) {
                module.debug('Adding form error messages', errors);
                module.set.error();
                $message.html(settings.templates.error(errors));
                ;
              }
            },
            remove: {prompt: function(identifier) {
                var $field = module.get.field(identifier),
                    $fieldGroup = $field.closest($group),
                    $prompt = $fieldGroup.children(selector.prompt);
                ;
                $fieldGroup.removeClass(className.error);
                ;
                if (settings.inline && $prompt.is(':visible')) {
                  module.verbose('Removing prompt for field', identifier);
                  if (settings.transition && $.fn.transition !== undefined && $module.transition('is supported')) {
                    $prompt.transition(settings.transition + ' out', settings.duration, function() {
                      $prompt.remove();
                    });
                  } else {
                    $prompt.fadeOut(settings.duration, function() {
                      $prompt.remove();
                    });
                    ;
                  }
                }
              }},
            set: {
              success: function() {
                $module.removeClass(className.error).addClass(className.success);
                ;
              },
              defaults: function() {
                $field.each(function() {
                  var $field = $(this),
                      isCheckbox = ($field.filter(selector.checkbox).length > 0),
                      value = (isCheckbox) ? $field.is(':checked') : $field.val();
                  ;
                  $field.data(metadata.defaultValue, value);
                });
                ;
              },
              error: function() {
                $module.removeClass(className.success).addClass(className.error);
                ;
              },
              value: function(field, value) {
                var fields = {};
                ;
                fields[field] = value;
                return module.set.values.call(element, fields);
              },
              values: function(fields) {
                if ($.isEmptyObject(fields)) {
                  return;
                }
                $.each(fields, function(key, value) {
                  var $field = module.get.field(key),
                      $element = $field.parent(),
                      isMultiple = $.isArray(value),
                      isCheckbox = $element.is(selector.uiCheckbox),
                      isDropdown = $element.is(selector.uiDropdown),
                      isRadio = ($field.is(selector.radio) && isCheckbox),
                      fieldExists = ($field.length > 0),
                      $multipleField;
                  ;
                  if (fieldExists) {
                    if (isMultiple && isCheckbox) {
                      module.verbose('Selecting multiple', value, $field);
                      $element.checkbox('uncheck');
                      $.each(value, function(index, value) {
                        $multipleField = $field.filter('[value="' + value + '"]');
                        $element = $multipleField.parent();
                        if ($multipleField.length > 0) {
                          $element.checkbox('check');
                        }
                      });
                    } else if (isRadio) {
                      module.verbose('Selecting radio value', value, $field);
                      $field.filter('[value="' + value + '"]').parent(selector.uiCheckbox).checkbox('check');
                      ;
                    } else if (isCheckbox) {
                      module.verbose('Setting checkbox value', value, $element);
                      if (value === true) {
                        $element.checkbox('check');
                      } else {
                        $element.checkbox('uncheck');
                      }
                    } else if (isDropdown) {
                      module.verbose('Setting dropdown value', value, $element);
                      $element.dropdown('set selected', value);
                    } else {
                      module.verbose('Setting field value', value, $field);
                      $field.val(value);
                    }
                  }
                });
              }
            },
            validate: {
              form: function(event, ignoreCallbacks) {
                var values = module.get.values(),
                    apiRequest;
                ;
                if (keyHeldDown) {
                  return false;
                }
                formErrors = [];
                if (module.is.valid()) {
                  module.debug('Form has no validation errors, submitting');
                  module.set.success();
                  if (ignoreCallbacks !== true) {
                    return settings.onSuccess.call(element, event, values);
                  }
                } else {
                  module.debug('Form has errors');
                  module.set.error();
                  if (!settings.inline) {
                    module.add.errors(formErrors);
                  }
                  if ($module.data('moduleApi') !== undefined) {
                    event.stopImmediatePropagation();
                  }
                  if (ignoreCallbacks !== true) {
                    return settings.onFailure.call(element, formErrors, values);
                  }
                }
              },
              field: function(field, fieldName) {
                var identifier = field.identifier || fieldName,
                    $field = module.get.field(identifier),
                    fieldValid = true,
                    fieldErrors = [];
                ;
                if (!field.identifier) {
                  module.debug('Using field name as identifier', identifier);
                  field.identifier = identifier;
                }
                if ($field.prop('disabled')) {
                  module.debug('Field is disabled. Skipping', identifier);
                  fieldValid = true;
                } else if (field.optional && $.trim($field.val()) === '') {
                  module.debug('Field is optional and empty. Skipping', identifier);
                  fieldValid = true;
                } else if (field.rules !== undefined) {
                  $.each(field.rules, function(index, rule) {
                    if (module.has.field(identifier) && !(module.validate.rule(field, rule))) {
                      module.debug('Field is invalid', identifier, rule.type);
                      fieldErrors.push(module.get.prompt(rule, field));
                      fieldValid = false;
                    }
                  });
                }
                if (fieldValid) {
                  module.remove.prompt(identifier, fieldErrors);
                  settings.onValid.call($field);
                } else {
                  formErrors = formErrors.concat(fieldErrors);
                  module.add.prompt(identifier, fieldErrors);
                  settings.onInvalid.call($field, fieldErrors);
                  return false;
                }
                return true;
              },
              rule: function(field, rule) {
                var $field = module.get.field(field.identifier),
                    type = rule.type,
                    value = $field.val(),
                    isValid = true,
                    ancillary = module.get.ancillaryValue(rule),
                    ruleName = module.get.ruleName(rule),
                    ruleFunction = settings.rules[ruleName];
                ;
                if (!$.isFunction(ruleFunction)) {
                  module.error(error.noRule, ruleName);
                  return;
                }
                value = (value === undefined || value === '' || value === null) ? '' : $.trim(value + '');
                ;
                return ruleFunction.call($field, value, ancillary);
              }
            },
            setting: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ($allModules.length > 1) {
                  title += ' ' + '(' + $allModules.length + ')';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          module.initialize();
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.form.settings = {
        name: 'Form',
        namespace: 'form',
        debug: false,
        verbose: false,
        performance: true,
        fields: false,
        keyboardShortcuts: true,
        on: 'submit',
        inline: false,
        delay: 200,
        revalidate: true,
        transition: 'scale',
        duration: 200,
        onValid: function() {},
        onInvalid: function() {},
        onSuccess: function() {
          return true;
        },
        onFailure: function() {
          return false;
        },
        metadata: {
          defaultValue: 'default',
          validate: 'validate'
        },
        regExp: {
          bracket: /\[(.*)\]/i,
          decimal: /^\-?\d*(\.\d+)?$/,
          email: "[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?",
          escape: /[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g,
          flags: /^\/(.*)\/(.*)?/,
          integer: /^\-?\d+$/,
          number: /^\-?\d*(\.\d+)?$/,
          url: /(https?:\/\/(?:www\.|(?!www))[^\s\.]+\.[^\s]{2,}|www\.[^\s]+\.[^\s]{2,})/i
        },
        text: {
          unspecifiedRule: 'Please enter a valid value',
          unspecifiedField: 'This field'
        },
        prompt: {
          empty: '{name} must have a value',
          checked: '{name} must be checked',
          email: '{name} must be a valid e-mail',
          url: '{name} must be a valid url',
          regExp: '{name} is not formatted correctly',
          integer: '{name} must be an integer',
          decimal: '{name} must be a decimal number',
          number: '{name} must be set to a number',
          is: '{name} must be "{ruleValue}"',
          isExactly: '{name} must be exactly "{ruleValue}"',
          not: '{name} cannot be set to "{ruleValue}"',
          notExactly: '{name} cannot be set to exactly "{ruleValue}"',
          contain: '{name} cannot contain "{ruleValue}"',
          containExactly: '{name} cannot contain exactly "{ruleValue}"',
          doesntContain: '{name} must contain  "{ruleValue}"',
          doesntContainExactly: '{name} must contain exactly "{ruleValue}"',
          minLength: '{name} must be at least {ruleValue} characters',
          length: '{name} must be at least {ruleValue} characters',
          exactLength: '{name} must be exactly {ruleValue} characters',
          maxLength: '{name} cannot be longer than {ruleValue} characters',
          match: '{name} must match {ruleValue} field',
          different: '{name} must have a different value than {ruleValue} field',
          creditCard: '{name} must be a valid credit card number',
          minCount: '{name} must have at least {ruleValue} choices',
          exactCount: '{name} must have exactly {ruleValue} choices',
          maxCount: '{name} must have {ruleValue} or less choices'
        },
        selector: {
          checkbox: 'input[type="checkbox"], input[type="radio"]',
          clear: '.clear',
          field: 'input, textarea, select',
          group: '.field',
          input: 'input',
          message: '.error.message',
          prompt: '.prompt.label',
          radio: 'input[type="radio"]',
          reset: '.reset:not([type="reset"])',
          submit: '.submit:not([type="submit"])',
          uiCheckbox: '.ui.checkbox',
          uiDropdown: '.ui.dropdown'
        },
        className: {
          error: 'error',
          label: 'ui prompt label',
          pressed: 'down',
          success: 'success'
        },
        error: {
          identifier: 'You must specify a string identifier for each field',
          method: 'The method you called is not defined.',
          noRule: 'There is no rule matching the one you specified',
          oldSyntax: 'Starting in 2.0 forms now only take a single settings object. Validation settings converted to new syntax automatically.'
        },
        templates: {
          error: function(errors) {
            var html = '<ul class="list">';
            ;
            $.each(errors, function(index, value) {
              html += '<li>' + value + '</li>';
            });
            html += '</ul>';
            return $(html);
          },
          prompt: function(errors) {
            return $('<div/>').addClass('ui basic red pointing prompt label').html(errors[0]);
            ;
          }
        },
        rules: {
          empty: function(value) {
            return !(value === undefined || '' === value || $.isArray(value) && value.length === 0);
          },
          checked: function() {
            return ($(this).filter(':checked').length > 0);
          },
          email: function(value) {
            var emailRegExp = new RegExp($.fn.form.settings.regExp.email, 'i');
            ;
            return emailRegExp.test(value);
          },
          url: function(value) {
            return $.fn.form.settings.regExp.url.test(value);
          },
          regExp: function(value, regExp) {
            var regExpParts = regExp.match($.fn.form.settings.regExp.flags),
                flags;
            ;
            if (regExpParts) {
              regExp = (regExpParts.length >= 2) ? regExpParts[1] : regExp;
              ;
              flags = (regExpParts.length >= 3) ? regExpParts[2] : '';
              ;
            }
            return value.match(new RegExp(regExp, flags));
          },
          integer: function(value, range) {
            var intRegExp = $.fn.form.settings.regExp.integer,
                min,
                max,
                parts;
            ;
            if (range === undefined || range === '' || range === '..') {} else if (range.indexOf('..') == -1) {
              if (intRegExp.test(range)) {
                min = max = range - 0;
              }
            } else {
              parts = range.split('..', 2);
              if (intRegExp.test(parts[0])) {
                min = parts[0] - 0;
              }
              if (intRegExp.test(parts[1])) {
                max = parts[1] - 0;
              }
            }
            return (intRegExp.test(value) && (min === undefined || value >= min) && (max === undefined || value <= max));
          },
          decimal: function(value) {
            return $.fn.form.settings.regExp.decimal.test(value);
          },
          number: function(value) {
            return $.fn.form.settings.regExp.number.test(value);
          },
          is: function(value, text) {
            text = (typeof text == 'string') ? text.toLowerCase() : text;
            ;
            value = (typeof value == 'string') ? value.toLowerCase() : value;
            ;
            return (value == text);
          },
          isExactly: function(value, text) {
            return (value == text);
          },
          not: function(value, notValue) {
            value = (typeof value == 'string') ? value.toLowerCase() : value;
            ;
            notValue = (typeof notValue == 'string') ? notValue.toLowerCase() : notValue;
            ;
            return (value != notValue);
          },
          notExactly: function(value, notValue) {
            return (value != notValue);
          },
          contains: function(value, text) {
            text = text.replace($.fn.form.settings.regExp.escape, "\\$&");
            return (value.search(new RegExp(text, 'i')) !== -1);
          },
          containsExactly: function(value, text) {
            text = text.replace($.fn.form.settings.regExp.escape, "\\$&");
            return (value.search(new RegExp(text)) !== -1);
          },
          doesntContain: function(value, text) {
            text = text.replace($.fn.form.settings.regExp.escape, "\\$&");
            return (value.search(new RegExp(text, 'i')) === -1);
          },
          doesntContainExactly: function(value, text) {
            text = text.replace($.fn.form.settings.regExp.escape, "\\$&");
            return (value.search(new RegExp(text)) === -1);
          },
          minLength: function(value, requiredLength) {
            return (value !== undefined) ? (value.length >= requiredLength) : false;
            ;
          },
          length: function(value, requiredLength) {
            return (value !== undefined) ? (value.length >= requiredLength) : false;
            ;
          },
          exactLength: function(value, requiredLength) {
            return (value !== undefined) ? (value.length == requiredLength) : false;
            ;
          },
          maxLength: function(value, maxLength) {
            return (value !== undefined) ? (value.length <= maxLength) : false;
            ;
          },
          match: function(value, identifier) {
            var $form = $(this),
                matchingValue;
            ;
            if ($('[data-validate="' + identifier + '"]').length > 0) {
              matchingValue = $('[data-validate="' + identifier + '"]').val();
            } else if ($('#' + identifier).length > 0) {
              matchingValue = $('#' + identifier).val();
            } else if ($('[name="' + identifier + '"]').length > 0) {
              matchingValue = $('[name="' + identifier + '"]').val();
            } else if ($('[name="' + identifier + '[]"]').length > 0) {
              matchingValue = $('[name="' + identifier + '[]"]');
            }
            return (matchingValue !== undefined) ? (value.toString() == matchingValue.toString()) : false;
            ;
          },
          different: function(value, identifier) {
            var $form = $(this),
                matchingValue;
            ;
            if ($('[data-validate="' + identifier + '"]').length > 0) {
              matchingValue = $('[data-validate="' + identifier + '"]').val();
            } else if ($('#' + identifier).length > 0) {
              matchingValue = $('#' + identifier).val();
            } else if ($('[name="' + identifier + '"]').length > 0) {
              matchingValue = $('[name="' + identifier + '"]').val();
            } else if ($('[name="' + identifier + '[]"]').length > 0) {
              matchingValue = $('[name="' + identifier + '[]"]');
            }
            return (matchingValue !== undefined) ? (value.toString() !== matchingValue.toString()) : false;
            ;
          },
          creditCard: function(cardNumber, cardTypes) {
            var cards = {
              visa: {
                pattern: /^4/,
                length: [16]
              },
              amex: {
                pattern: /^3[47]/,
                length: [15]
              },
              mastercard: {
                pattern: /^5[1-5]/,
                length: [16]
              },
              discover: {
                pattern: /^(6011|622(12[6-9]|1[3-9][0-9]|[2-8][0-9]{2}|9[0-1][0-9]|92[0-5]|64[4-9])|65)/,
                length: [16]
              },
              unionPay: {
                pattern: /^(62|88)/,
                length: [16, 17, 18, 19]
              },
              jcb: {
                pattern: /^35(2[89]|[3-8][0-9])/,
                length: [16]
              },
              maestro: {
                pattern: /^(5018|5020|5038|6304|6759|676[1-3])/,
                length: [12, 13, 14, 15, 16, 17, 18, 19]
              },
              dinersClub: {
                pattern: /^(30[0-5]|^36)/,
                length: [14]
              },
              laser: {
                pattern: /^(6304|670[69]|6771)/,
                length: [16, 17, 18, 19]
              },
              visaElectron: {
                pattern: /^(4026|417500|4508|4844|491(3|7))/,
                length: [16]
              }
            },
                valid = {},
                validCard = false,
                requiredTypes = (typeof cardTypes == 'string') ? cardTypes.split(',') : false,
                unionPay,
                validation;
            ;
            if (typeof cardNumber !== 'string' || cardNumber.length === 0) {
              return;
            }
            if (requiredTypes) {
              $.each(requiredTypes, function(index, type) {
                validation = cards[type];
                if (validation) {
                  valid = {
                    length: ($.inArray(cardNumber.length, validation.length) !== -1),
                    pattern: (cardNumber.search(validation.pattern) !== -1)
                  };
                  if (valid.length && valid.pattern) {
                    validCard = true;
                  }
                }
              });
              if (!validCard) {
                return false;
              }
            }
            unionPay = {
              number: ($.inArray(cardNumber.length, cards.unionPay.length) !== -1),
              pattern: (cardNumber.search(cards.unionPay.pattern) !== -1)
            };
            if (unionPay.number && unionPay.pattern) {
              return true;
            }
            var length = cardNumber.length,
                multiple = 0,
                producedValue = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [0, 2, 4, 6, 8, 1, 3, 5, 7, 9]],
                sum = 0;
            ;
            while (length--) {
              sum += producedValue[multiple][parseInt(cardNumber.charAt(length), 10)];
              multiple ^= 1;
            }
            return (sum % 10 === 0 && sum > 0);
          },
          minCount: function(value, minCount) {
            if (minCount == 0) {
              return true;
            }
            if (minCount == 1) {
              return (value !== '');
            }
            return (value.split(',').length >= minCount);
          },
          exactCount: function(value, exactCount) {
            if (exactCount == 0) {
              return (value === '');
            }
            if (exactCount == 1) {
              return (value !== '' && value.search(',') === -1);
            }
            return (value.split(',').length == exactCount);
          },
          maxCount: function(value, maxCount) {
            if (maxCount == 0) {
              return false;
            }
            if (maxCount == 1) {
              return (value.search(',') === -1);
            }
            return (value.split(',').length <= maxCount);
          }
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.accordion = function(parameters) {
        var $allModules = $(this),
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
              setTimeout(callback, 0);
            },
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.accordion.settings, parameters) : $.extend({}, $.fn.accordion.settings),
              className = settings.className,
              namespace = settings.namespace,
              selector = settings.selector,
              error = settings.error,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              moduleSelector = $allModules.selector || '',
              $module = $(this),
              $title = $module.find(selector.title),
              $content = $module.find(selector.content),
              element = this,
              instance = $module.data(moduleNamespace),
              observer,
              module;
          ;
          module = {
            initialize: function() {
              module.debug('Initializing', $module);
              module.bind.events();
              if (settings.observeChanges) {
                module.observeChanges();
              }
              module.instantiate();
            },
            instantiate: function() {
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.debug('Destroying previous instance', $module);
              $module.off(eventNamespace).removeData(moduleNamespace);
              ;
            },
            refresh: function() {
              $title = $module.find(selector.title);
              $content = $module.find(selector.content);
            },
            observeChanges: function() {
              if ('MutationObserver' in window) {
                observer = new MutationObserver(function(mutations) {
                  module.debug('DOM tree modified, updating selector cache');
                  module.refresh();
                });
                observer.observe(element, {
                  childList: true,
                  subtree: true
                });
                module.debug('Setting up mutation observer', observer);
              }
            },
            bind: {events: function() {
                module.debug('Binding delegated events');
                $module.on(settings.on + eventNamespace, selector.trigger, module.event.click);
                ;
              }},
            event: {click: function() {
                module.toggle.call(this);
              }},
            toggle: function(query) {
              var $activeTitle = (query !== undefined) ? (typeof query === 'number') ? $title.eq(query) : $(query).closest(selector.title) : $(this).closest(selector.title),
                  $activeContent = $activeTitle.next($content),
                  isAnimating = $activeContent.hasClass(className.animating),
                  isActive = $activeContent.hasClass(className.active),
                  isOpen = (isActive && !isAnimating),
                  isOpening = (!isActive && isAnimating);
              ;
              module.debug('Toggling visibility of content', $activeTitle);
              if (isOpen || isOpening) {
                if (settings.collapsible) {
                  module.close.call($activeTitle);
                } else {
                  module.debug('Cannot close accordion content collapsing is disabled');
                }
              } else {
                module.open.call($activeTitle);
              }
            },
            open: function(query) {
              var $activeTitle = (query !== undefined) ? (typeof query === 'number') ? $title.eq(query) : $(query).closest(selector.title) : $(this).closest(selector.title),
                  $activeContent = $activeTitle.next($content),
                  isAnimating = $activeContent.hasClass(className.animating),
                  isActive = $activeContent.hasClass(className.active),
                  isOpen = (isActive || isAnimating);
              ;
              if (isOpen) {
                module.debug('Accordion already open, skipping', $activeContent);
                return;
              }
              module.debug('Opening accordion content', $activeTitle);
              settings.onOpening.call($activeContent);
              if (settings.exclusive) {
                module.closeOthers.call($activeTitle);
              }
              $activeTitle.addClass(className.active);
              ;
              $activeContent.stop(true, true).addClass(className.animating);
              ;
              if (settings.animateChildren) {
                if ($.fn.transition !== undefined && $module.transition('is supported')) {
                  $activeContent.children().transition({
                    animation: 'fade in',
                    queue: false,
                    useFailSafe: true,
                    debug: settings.debug,
                    verbose: settings.verbose,
                    duration: settings.duration
                  });
                  ;
                } else {
                  $activeContent.children().stop(true, true).animate({opacity: 1}, settings.duration, module.resetOpacity);
                  ;
                }
              }
              $activeContent.slideDown(settings.duration, settings.easing, function() {
                $activeContent.removeClass(className.animating).addClass(className.active);
                ;
                module.reset.display.call(this);
                settings.onOpen.call(this);
                settings.onChange.call(this);
              });
              ;
            },
            close: function(query) {
              var $activeTitle = (query !== undefined) ? (typeof query === 'number') ? $title.eq(query) : $(query).closest(selector.title) : $(this).closest(selector.title),
                  $activeContent = $activeTitle.next($content),
                  isAnimating = $activeContent.hasClass(className.animating),
                  isActive = $activeContent.hasClass(className.active),
                  isOpening = (!isActive && isAnimating),
                  isClosing = (isActive && isAnimating);
              ;
              if ((isActive || isOpening) && !isClosing) {
                module.debug('Closing accordion content', $activeContent);
                settings.onClosing.call($activeContent);
                $activeTitle.removeClass(className.active);
                ;
                $activeContent.stop(true, true).addClass(className.animating);
                ;
                if (settings.animateChildren) {
                  if ($.fn.transition !== undefined && $module.transition('is supported')) {
                    $activeContent.children().transition({
                      animation: 'fade out',
                      queue: false,
                      useFailSafe: true,
                      debug: settings.debug,
                      verbose: settings.verbose,
                      duration: settings.duration
                    });
                    ;
                  } else {
                    $activeContent.children().stop(true, true).animate({opacity: 0}, settings.duration, module.resetOpacity);
                    ;
                  }
                }
                $activeContent.slideUp(settings.duration, settings.easing, function() {
                  $activeContent.removeClass(className.animating).removeClass(className.active);
                  ;
                  module.reset.display.call(this);
                  settings.onClose.call(this);
                  settings.onChange.call(this);
                });
                ;
              }
            },
            closeOthers: function(index) {
              var $activeTitle = (index !== undefined) ? $title.eq(index) : $(this).closest(selector.title),
                  $parentTitles = $activeTitle.parents(selector.content).prev(selector.title),
                  $activeAccordion = $activeTitle.closest(selector.accordion),
                  activeSelector = selector.title + '.' + className.active + ':visible',
                  activeContent = selector.content + '.' + className.active + ':visible',
                  $openTitles,
                  $nestedTitles,
                  $openContents;
              ;
              if (settings.closeNested) {
                $openTitles = $activeAccordion.find(activeSelector).not($parentTitles);
                $openContents = $openTitles.next($content);
              } else {
                $openTitles = $activeAccordion.find(activeSelector).not($parentTitles);
                $nestedTitles = $activeAccordion.find(activeContent).find(activeSelector).not($parentTitles);
                $openTitles = $openTitles.not($nestedTitles);
                $openContents = $openTitles.next($content);
              }
              if (($openTitles.length > 0)) {
                module.debug('Exclusive enabled, closing other content', $openTitles);
                $openTitles.removeClass(className.active);
                ;
                $openContents.removeClass(className.animating).stop(true, true);
                ;
                if (settings.animateChildren) {
                  if ($.fn.transition !== undefined && $module.transition('is supported')) {
                    $openContents.children().transition({
                      animation: 'fade out',
                      useFailSafe: true,
                      debug: settings.debug,
                      verbose: settings.verbose,
                      duration: settings.duration
                    });
                    ;
                  } else {
                    $openContents.children().stop(true, true).animate({opacity: 0}, settings.duration, module.resetOpacity);
                    ;
                  }
                }
                $openContents.slideUp(settings.duration, settings.easing, function() {
                  $(this).removeClass(className.active);
                  module.reset.display.call(this);
                });
                ;
              }
            },
            reset: {
              display: function() {
                module.verbose('Removing inline display from element', this);
                $(this).css('display', '');
                if ($(this).attr('style') === '') {
                  $(this).attr('style', '').removeAttr('style');
                  ;
                }
              },
              opacity: function() {
                module.verbose('Removing inline opacity from element', this);
                $(this).css('opacity', '');
                if ($(this).attr('style') === '') {
                  $(this).attr('style', '').removeAttr('style');
                  ;
                }
              }
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              module.debug('Changing internal', name, value);
              if (value !== undefined) {
                if ($.isPlainObject(name)) {
                  $.extend(true, module, name);
                } else {
                  module[name] = value;
                }
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.accordion.settings = {
        name: 'Accordion',
        namespace: 'accordion',
        debug: false,
        verbose: false,
        performance: true,
        on: 'click',
        observeChanges: true,
        exclusive: true,
        collapsible: true,
        closeNested: false,
        animateChildren: true,
        duration: 350,
        easing: 'easeOutQuad',
        onOpening: function() {},
        onOpen: function() {},
        onClosing: function() {},
        onClose: function() {},
        onChange: function() {},
        error: {method: 'The method you called is not defined'},
        className: {
          active: 'active',
          animating: 'animating'
        },
        selector: {
          accordion: '.accordion',
          title: '.title',
          trigger: '.title',
          content: '.content'
        }
      };
      $.extend($.easing, {easeOutQuad: function(x, t, b, c, d) {
          return -c * (t /= d) * (t - 2) + b;
        }});
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.checkbox = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = $.extend(true, {}, $.fn.checkbox.settings, parameters),
              className = settings.className,
              namespace = settings.namespace,
              selector = settings.selector,
              error = settings.error,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $module = $(this),
              $label = $(this).children(selector.label),
              $input = $(this).children(selector.input),
              input = $input[0],
              initialLoad = false,
              shortcutPressed = false,
              instance = $module.data(moduleNamespace),
              observer,
              element = this,
              module;
          ;
          module = {
            initialize: function() {
              module.verbose('Initializing checkbox', settings);
              module.create.label();
              module.bind.events();
              module.set.tabbable();
              module.hide.input();
              module.observeChanges();
              module.instantiate();
              module.setup();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.verbose('Destroying module');
              module.unbind.events();
              module.show.input();
              $module.removeData(moduleNamespace);
            },
            fix: {reference: function() {
                if ($module.is(selector.input)) {
                  module.debug('Behavior called on <input> adjusting invoked element');
                  $module = $module.closest(selector.checkbox);
                  module.refresh();
                }
              }},
            setup: function() {
              module.set.initialLoad();
              if (module.is.indeterminate()) {
                module.debug('Initial value is indeterminate');
                module.indeterminate();
              } else if (module.is.checked()) {
                module.debug('Initial value is checked');
                module.check();
              } else {
                module.debug('Initial value is unchecked');
                module.uncheck();
              }
              module.remove.initialLoad();
            },
            refresh: function() {
              $label = $module.children(selector.label);
              $input = $module.children(selector.input);
              input = $input[0];
            },
            hide: {input: function() {
                module.verbose('Modfying <input> z-index to be unselectable');
                $input.addClass(className.hidden);
              }},
            show: {input: function() {
                module.verbose('Modfying <input> z-index to be selectable');
                $input.removeClass(className.hidden);
              }},
            observeChanges: function() {
              if ('MutationObserver' in window) {
                observer = new MutationObserver(function(mutations) {
                  module.debug('DOM tree modified, updating selector cache');
                  module.refresh();
                });
                observer.observe(element, {
                  childList: true,
                  subtree: true
                });
                module.debug('Setting up mutation observer', observer);
              }
            },
            attachEvents: function(selector, event) {
              var $element = $(selector);
              ;
              event = $.isFunction(module[event]) ? module[event] : module.toggle;
              ;
              if ($element.length > 0) {
                module.debug('Attaching checkbox events to element', selector, event);
                $element.on('click' + eventNamespace, event);
                ;
              } else {
                module.error(error.notFound);
              }
            },
            event: {
              click: function(event) {
                var $target = $(event.target);
                ;
                if ($target.is(selector.input)) {
                  module.verbose('Using default check action on initialized checkbox');
                  return;
                }
                if ($target.is(selector.link)) {
                  module.debug('Clicking link inside checkbox, skipping toggle');
                  return;
                }
                module.toggle();
                $input.focus();
                event.preventDefault();
              },
              keydown: function(event) {
                var key = event.which,
                    keyCode = {
                      enter: 13,
                      space: 32,
                      escape: 27
                    };
                ;
                if (key == keyCode.escape) {
                  module.verbose('Escape key pressed blurring field');
                  $input.blur();
                  shortcutPressed = true;
                } else if (!event.ctrlKey && (key == keyCode.space || key == keyCode.enter)) {
                  module.verbose('Enter/space key pressed, toggling checkbox');
                  module.toggle();
                  shortcutPressed = true;
                } else {
                  shortcutPressed = false;
                }
              },
              keyup: function(event) {
                if (shortcutPressed) {
                  event.preventDefault();
                }
              }
            },
            check: function() {
              if (!module.should.allowCheck()) {
                return;
              }
              module.debug('Checking checkbox', $input);
              module.set.checked();
              if (!module.should.ignoreCallbacks()) {
                settings.onChecked.call(input);
                settings.onChange.call(input);
              }
            },
            uncheck: function() {
              if (!module.should.allowUncheck()) {
                return;
              }
              module.debug('Unchecking checkbox');
              module.set.unchecked();
              if (!module.should.ignoreCallbacks()) {
                settings.onUnchecked.call(input);
                settings.onChange.call(input);
              }
            },
            indeterminate: function() {
              if (module.should.allowIndeterminate()) {
                module.debug('Checkbox is already indeterminate');
                return;
              }
              module.debug('Making checkbox indeterminate');
              module.set.indeterminate();
              if (!module.should.ignoreCallbacks()) {
                settings.onIndeterminate.call(input);
                settings.onChange.call(input);
              }
            },
            determinate: function() {
              if (module.should.allowDeterminate()) {
                module.debug('Checkbox is already determinate');
                return;
              }
              module.debug('Making checkbox determinate');
              module.set.determinate();
              if (!module.should.ignoreCallbacks()) {
                settings.onDeterminate.call(input);
                settings.onChange.call(input);
              }
            },
            enable: function() {
              if (module.is.enabled()) {
                module.debug('Checkbox is already enabled');
                return;
              }
              module.debug('Enabling checkbox');
              module.set.enabled();
              settings.onEnable.call(input);
            },
            disable: function() {
              if (module.is.disabled()) {
                module.debug('Checkbox is already disabled');
                return;
              }
              module.debug('Disabling checkbox');
              module.set.disabled();
              settings.onDisable.call(input);
            },
            get: {
              radios: function() {
                var name = module.get.name();
                ;
                return $('input[name="' + name + '"]').closest(selector.checkbox);
              },
              otherRadios: function() {
                return module.get.radios().not($module);
              },
              name: function() {
                return $input.attr('name');
              }
            },
            is: {
              initialLoad: function() {
                return initialLoad;
              },
              radio: function() {
                return ($input.hasClass(className.radio) || $input.attr('type') == 'radio');
              },
              indeterminate: function() {
                return $input.prop('indeterminate') !== undefined && $input.prop('indeterminate');
              },
              checked: function() {
                return $input.prop('checked') !== undefined && $input.prop('checked');
              },
              disabled: function() {
                return $input.prop('disabled') !== undefined && $input.prop('disabled');
              },
              enabled: function() {
                return !module.is.disabled();
              },
              determinate: function() {
                return !module.is.indeterminate();
              },
              unchecked: function() {
                return !module.is.checked();
              }
            },
            should: {
              allowCheck: function() {
                if (module.is.determinate() && module.is.checked() && !module.should.forceCallbacks()) {
                  module.debug('Should not allow check, checkbox is already checked');
                  return false;
                }
                if (settings.beforeChecked.apply(input) === false) {
                  module.debug('Should not allow check, beforeChecked cancelled');
                  return false;
                }
                return true;
              },
              allowUncheck: function() {
                if (module.is.determinate() && module.is.unchecked() && !module.should.forceCallbacks()) {
                  module.debug('Should not allow uncheck, checkbox is already unchecked');
                  return false;
                }
                if (settings.beforeUnchecked.apply(input) === false) {
                  module.debug('Should not allow uncheck, beforeUnchecked cancelled');
                  return false;
                }
                return true;
              },
              allowIndeterminate: function() {
                if (module.is.indeterminate() && !module.should.forceCallbacks()) {
                  module.debug('Should not allow indeterminate, checkbox is already indeterminate');
                  return false;
                }
                if (settings.beforeIndeterminate.apply(input) === false) {
                  module.debug('Should not allow indeterminate, beforeIndeterminate cancelled');
                  return false;
                }
                return true;
              },
              allowDeterminate: function() {
                if (module.is.determinate() && !module.should.forceCallbacks()) {
                  module.debug('Should not allow determinate, checkbox is already determinate');
                  return false;
                }
                if (settings.beforeDeterminate.apply(input) === false) {
                  module.debug('Should not allow determinate, beforeDeterminate cancelled');
                  return false;
                }
                return true;
              },
              forceCallbacks: function() {
                return (module.is.initialLoad() && settings.fireOnInit);
              },
              ignoreCallbacks: function() {
                return (initialLoad && !settings.fireOnInit);
              }
            },
            can: {
              change: function() {
                return !($module.hasClass(className.disabled) || $module.hasClass(className.readOnly) || $input.prop('disabled') || $input.prop('readonly'));
              },
              uncheck: function() {
                return (typeof settings.uncheckable === 'boolean') ? settings.uncheckable : !module.is.radio();
                ;
              }
            },
            set: {
              initialLoad: function() {
                initialLoad = true;
              },
              checked: function() {
                module.verbose('Setting class to checked');
                $module.removeClass(className.indeterminate).addClass(className.checked);
                ;
                if (module.is.radio()) {
                  module.uncheckOthers();
                }
                if (!module.is.indeterminate() && module.is.checked()) {
                  module.debug('Input is already checked, skipping input property change');
                  return;
                }
                module.verbose('Setting state to checked', input);
                $input.prop('indeterminate', false).prop('checked', true);
                ;
                module.trigger.change();
              },
              unchecked: function() {
                module.verbose('Removing checked class');
                $module.removeClass(className.indeterminate).removeClass(className.checked);
                ;
                if (!module.is.indeterminate() && module.is.unchecked()) {
                  module.debug('Input is already unchecked');
                  return;
                }
                module.debug('Setting state to unchecked');
                $input.prop('indeterminate', false).prop('checked', false);
                ;
                module.trigger.change();
              },
              indeterminate: function() {
                module.verbose('Setting class to indeterminate');
                $module.addClass(className.indeterminate);
                ;
                if (module.is.indeterminate()) {
                  module.debug('Input is already indeterminate, skipping input property change');
                  return;
                }
                module.debug('Setting state to indeterminate');
                $input.prop('indeterminate', true);
                ;
                module.trigger.change();
              },
              determinate: function() {
                module.verbose('Removing indeterminate class');
                $module.removeClass(className.indeterminate);
                ;
                if (module.is.determinate()) {
                  module.debug('Input is already determinate, skipping input property change');
                  return;
                }
                module.debug('Setting state to determinate');
                $input.prop('indeterminate', false);
                ;
              },
              disabled: function() {
                module.verbose('Setting class to disabled');
                $module.addClass(className.disabled);
                ;
                if (module.is.disabled()) {
                  module.debug('Input is already disabled, skipping input property change');
                  return;
                }
                module.debug('Setting state to disabled');
                $input.prop('disabled', 'disabled');
                ;
                module.trigger.change();
              },
              enabled: function() {
                module.verbose('Removing disabled class');
                $module.removeClass(className.disabled);
                if (module.is.enabled()) {
                  module.debug('Input is already enabled, skipping input property change');
                  return;
                }
                module.debug('Setting state to enabled');
                $input.prop('disabled', false);
                ;
                module.trigger.change();
              },
              tabbable: function() {
                module.verbose('Adding tabindex to checkbox');
                if ($input.attr('tabindex') === undefined) {
                  $input.attr('tabindex', 0);
                }
              }
            },
            remove: {initialLoad: function() {
                initialLoad = false;
              }},
            trigger: {change: function() {
                module.verbose('Triggering change event from programmatic change');
                $input.trigger('change');
                ;
              }},
            create: {label: function() {
                if ($input.prevAll(selector.label).length > 0) {
                  $input.prev(selector.label).detach().insertAfter($input);
                  module.debug('Moving existing label', $label);
                } else if (!module.has.label()) {
                  $label = $('<label>').insertAfter($input);
                  module.debug('Creating label', $label);
                }
              }},
            has: {label: function() {
                return ($label.length > 0);
              }},
            bind: {events: function() {
                module.verbose('Attaching checkbox events');
                $module.on('click' + eventNamespace, module.event.click).on('keydown' + eventNamespace, selector.input, module.event.keydown).on('keyup' + eventNamespace, selector.input, module.event.keyup);
                ;
              }},
            unbind: {events: function() {
                module.debug('Removing events');
                $module.off(eventNamespace);
                ;
              }},
            uncheckOthers: function() {
              var $radios = module.get.otherRadios();
              ;
              module.debug('Unchecking other radios', $radios);
              $radios.removeClass(className.checked);
            },
            toggle: function() {
              if (!module.can.change()) {
                if (!module.is.radio()) {
                  module.debug('Checkbox is read-only or disabled, ignoring toggle');
                }
                return;
              }
              if (module.is.indeterminate() || module.is.unchecked()) {
                module.debug('Currently unchecked');
                module.check();
              } else if (module.is.checked() && module.can.uncheck()) {
                module.debug('Currently checked');
                module.uncheck();
              }
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.checkbox.settings = {
        name: 'Checkbox',
        namespace: 'checkbox',
        debug: false,
        verbose: true,
        performance: true,
        uncheckable: 'auto',
        fireOnInit: false,
        onChange: function() {},
        beforeChecked: function() {},
        beforeUnchecked: function() {},
        beforeDeterminate: function() {},
        beforeIndeterminate: function() {},
        onChecked: function() {},
        onUnchecked: function() {},
        onDeterminate: function() {},
        onIndeterminate: function() {},
        onEnabled: function() {},
        onDisabled: function() {},
        className: {
          checked: 'checked',
          indeterminate: 'indeterminate',
          disabled: 'disabled',
          hidden: 'hidden',
          radio: 'radio',
          readOnly: 'read-only'
        },
        error: {method: 'The method you called is not defined'},
        selector: {
          checkbox: '.ui.checkbox',
          label: 'label, .box',
          input: 'input[type="checkbox"], input[type="radio"]',
          link: 'a[href]'
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.dimmer = function(parameters) {
        var $allModules = $(this),
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.dimmer.settings, parameters) : $.extend({}, $.fn.dimmer.settings),
              selector = settings.selector,
              namespace = settings.namespace,
              className = settings.className,
              error = settings.error,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              moduleSelector = $allModules.selector || '',
              clickEvent = ('ontouchstart' in document.documentElement) ? 'touchstart' : 'click',
              $module = $(this),
              $dimmer,
              $dimmable,
              element = this,
              instance = $module.data(moduleNamespace),
              module;
          ;
          module = {
            preinitialize: function() {
              if (module.is.dimmer()) {
                $dimmable = $module.parent();
                $dimmer = $module;
              } else {
                $dimmable = $module;
                if (module.has.dimmer()) {
                  if (settings.dimmerName) {
                    $dimmer = $dimmable.find(selector.dimmer).filter('.' + settings.dimmerName);
                  } else {
                    $dimmer = $dimmable.find(selector.dimmer);
                  }
                } else {
                  $dimmer = module.create();
                }
              }
            },
            initialize: function() {
              module.debug('Initializing dimmer', settings);
              module.bind.events();
              module.set.dimmable();
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, instance);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous module', $dimmer);
              module.unbind.events();
              module.remove.variation();
              $dimmable.off(eventNamespace);
              ;
            },
            bind: {events: function() {
                if (settings.on == 'hover') {
                  $dimmable.on('mouseenter' + eventNamespace, module.show).on('mouseleave' + eventNamespace, module.hide);
                  ;
                } else if (settings.on == 'click') {
                  $dimmable.on(clickEvent + eventNamespace, module.toggle);
                  ;
                }
                if (module.is.page()) {
                  module.debug('Setting as a page dimmer', $dimmable);
                  module.set.pageDimmer();
                }
                if (module.is.closable()) {
                  module.verbose('Adding dimmer close event', $dimmer);
                  $dimmable.on(clickEvent + eventNamespace, selector.dimmer, module.event.click);
                  ;
                }
              }},
            unbind: {events: function() {
                $module.removeData(moduleNamespace);
                ;
              }},
            event: {click: function(event) {
                module.verbose('Determining if event occured on dimmer', event);
                if ($dimmer.find(event.target).length === 0 || $(event.target).is(selector.content)) {
                  module.hide();
                  event.stopImmediatePropagation();
                }
              }},
            addContent: function(element) {
              var $content = $(element);
              ;
              module.debug('Add content to dimmer', $content);
              if ($content.parent()[0] !== $dimmer[0]) {
                $content.detach().appendTo($dimmer);
              }
            },
            create: function() {
              var $element = $(settings.template.dimmer());
              ;
              if (settings.variation) {
                module.debug('Creating dimmer with variation', settings.variation);
                $element.addClass(settings.variation);
              }
              if (settings.dimmerName) {
                module.debug('Creating named dimmer', settings.dimmerName);
                $element.addClass(settings.dimmerName);
              }
              $element.appendTo($dimmable);
              ;
              return $element;
            },
            show: function(callback) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              module.debug('Showing dimmer', $dimmer, settings);
              if ((!module.is.dimmed() || module.is.animating()) && module.is.enabled()) {
                module.animate.show(callback);
                settings.onShow.call(element);
                settings.onChange.call(element);
              } else {
                module.debug('Dimmer is already shown or disabled');
              }
            },
            hide: function(callback) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              if (module.is.dimmed() || module.is.animating()) {
                module.debug('Hiding dimmer', $dimmer);
                module.animate.hide(callback);
                settings.onHide.call(element);
                settings.onChange.call(element);
              } else {
                module.debug('Dimmer is not visible');
              }
            },
            toggle: function() {
              module.verbose('Toggling dimmer visibility', $dimmer);
              if (!module.is.dimmed()) {
                module.show();
              } else {
                module.hide();
              }
            },
            animate: {
              show: function(callback) {
                callback = $.isFunction(callback) ? callback : function() {};
                ;
                if (settings.useCSS && $.fn.transition !== undefined && $dimmer.transition('is supported')) {
                  if (settings.opacity !== 'auto') {
                    module.set.opacity();
                  }
                  $dimmer.transition({
                    animation: settings.transition + ' in',
                    queue: false,
                    duration: module.get.duration(),
                    useFailSafe: true,
                    onStart: function() {
                      module.set.dimmed();
                    },
                    onComplete: function() {
                      module.set.active();
                      callback();
                    }
                  });
                  ;
                } else {
                  module.verbose('Showing dimmer animation with javascript');
                  module.set.dimmed();
                  if (settings.opacity == 'auto') {
                    settings.opacity = 0.8;
                  }
                  $dimmer.stop().css({
                    opacity: 0,
                    width: '100%',
                    height: '100%'
                  }).fadeTo(module.get.duration(), settings.opacity, function() {
                    $dimmer.removeAttr('style');
                    module.set.active();
                    callback();
                  });
                  ;
                }
              },
              hide: function(callback) {
                callback = $.isFunction(callback) ? callback : function() {};
                ;
                if (settings.useCSS && $.fn.transition !== undefined && $dimmer.transition('is supported')) {
                  module.verbose('Hiding dimmer with css');
                  $dimmer.transition({
                    animation: settings.transition + ' out',
                    queue: false,
                    duration: module.get.duration(),
                    useFailSafe: true,
                    onStart: function() {
                      module.remove.dimmed();
                    },
                    onComplete: function() {
                      module.remove.active();
                      callback();
                    }
                  });
                  ;
                } else {
                  module.verbose('Hiding dimmer with javascript');
                  module.remove.dimmed();
                  $dimmer.stop().fadeOut(module.get.duration(), function() {
                    module.remove.active();
                    $dimmer.removeAttr('style');
                    callback();
                  });
                  ;
                }
              }
            },
            get: {
              dimmer: function() {
                return $dimmer;
              },
              duration: function() {
                if (typeof settings.duration == 'object') {
                  if (module.is.active()) {
                    return settings.duration.hide;
                  } else {
                    return settings.duration.show;
                  }
                }
                return settings.duration;
              }
            },
            has: {dimmer: function() {
                if (settings.dimmerName) {
                  return ($module.find(selector.dimmer).filter('.' + settings.dimmerName).length > 0);
                } else {
                  return ($module.find(selector.dimmer).length > 0);
                }
              }},
            is: {
              active: function() {
                return $dimmer.hasClass(className.active);
              },
              animating: function() {
                return ($dimmer.is(':animated') || $dimmer.hasClass(className.animating));
              },
              closable: function() {
                if (settings.closable == 'auto') {
                  if (settings.on == 'hover') {
                    return false;
                  }
                  return true;
                }
                return settings.closable;
              },
              dimmer: function() {
                return $module.hasClass(className.dimmer);
              },
              dimmable: function() {
                return $module.hasClass(className.dimmable);
              },
              dimmed: function() {
                return $dimmable.hasClass(className.dimmed);
              },
              disabled: function() {
                return $dimmable.hasClass(className.disabled);
              },
              enabled: function() {
                return !module.is.disabled();
              },
              page: function() {
                return $dimmable.is('body');
              },
              pageDimmer: function() {
                return $dimmer.hasClass(className.pageDimmer);
              }
            },
            can: {show: function() {
                return !$dimmer.hasClass(className.disabled);
              }},
            set: {
              opacity: function(opacity) {
                var color = $dimmer.css('background-color'),
                    colorArray = color.split(','),
                    isRGBA = (colorArray && colorArray.length == 4);
                ;
                opacity = settings.opacity || opacity;
                if (isRGBA) {
                  colorArray[3] = opacity + ')';
                  color = colorArray.join(',');
                } else {
                  color = 'rgba(0, 0, 0, ' + opacity + ')';
                }
                module.debug('Setting opacity to', opacity);
                $dimmer.css('background-color', color);
              },
              active: function() {
                $dimmer.addClass(className.active);
              },
              dimmable: function() {
                $dimmable.addClass(className.dimmable);
              },
              dimmed: function() {
                $dimmable.addClass(className.dimmed);
              },
              pageDimmer: function() {
                $dimmer.addClass(className.pageDimmer);
              },
              disabled: function() {
                $dimmer.addClass(className.disabled);
              },
              variation: function(variation) {
                variation = variation || settings.variation;
                if (variation) {
                  $dimmer.addClass(variation);
                }
              }
            },
            remove: {
              active: function() {
                $dimmer.removeClass(className.active);
                ;
              },
              dimmed: function() {
                $dimmable.removeClass(className.dimmed);
              },
              disabled: function() {
                $dimmer.removeClass(className.disabled);
              },
              variation: function(variation) {
                variation = variation || settings.variation;
                if (variation) {
                  $dimmer.removeClass(variation);
                }
              }
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ($allModules.length > 1) {
                  title += ' ' + '(' + $allModules.length + ')';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          module.preinitialize();
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.dimmer.settings = {
        name: 'Dimmer',
        namespace: 'dimmer',
        debug: false,
        verbose: false,
        performance: true,
        dimmerName: false,
        variation: false,
        closable: 'auto',
        useCSS: true,
        transition: 'fade',
        on: false,
        opacity: 'auto',
        duration: {
          show: 500,
          hide: 500
        },
        onChange: function() {},
        onShow: function() {},
        onHide: function() {},
        error: {method: 'The method you called is not defined.'},
        className: {
          active: 'active',
          animating: 'animating',
          dimmable: 'dimmable',
          dimmed: 'dimmed',
          dimmer: 'dimmer',
          disabled: 'disabled',
          hide: 'hide',
          pageDimmer: 'page',
          show: 'show'
        },
        selector: {
          dimmer: '> .ui.dimmer',
          content: '.ui.dimmer > .content, .ui.dimmer > .content > .center'
        },
        template: {dimmer: function() {
            return $('<div />').attr('class', 'ui dimmer');
          }}
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.dropdown = function(parameters) {
        var $allModules = $(this),
            $document = $(document),
            moduleSelector = $allModules.selector || '',
            hasTouch = ('ontouchstart' in document.documentElement),
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function(elementIndex) {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.dropdown.settings, parameters) : $.extend({}, $.fn.dropdown.settings),
              className = settings.className,
              message = settings.message,
              fields = settings.fields,
              metadata = settings.metadata,
              namespace = settings.namespace,
              regExp = settings.regExp,
              selector = settings.selector,
              error = settings.error,
              templates = settings.templates,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $module = $(this),
              $context = $(settings.context),
              $text = $module.find(selector.text),
              $search = $module.find(selector.search),
              $input = $module.find(selector.input),
              $icon = $module.find(selector.icon),
              $combo = ($module.prev().find(selector.text).length > 0) ? $module.prev().find(selector.text) : $module.prev(),
              $menu = $module.children(selector.menu),
              $item = $menu.find(selector.item),
              activated = false,
              itemActivated = false,
              internalChange = false,
              element = this,
              instance = $module.data(moduleNamespace),
              initialLoad,
              pageLostFocus,
              elementNamespace,
              id,
              selectObserver,
              menuObserver,
              module;
          ;
          module = {
            initialize: function() {
              module.debug('Initializing dropdown', settings);
              if (module.is.alreadySetup()) {
                module.setup.reference();
              } else {
                module.setup.layout();
                module.refreshData();
                module.save.defaults();
                module.restore.selected();
                module.create.id();
                module.bind.events();
                module.observeChanges();
                module.instantiate();
              }
            },
            instantiate: function() {
              module.verbose('Storing instance of dropdown', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous dropdown', $module);
              module.remove.tabbable();
              $module.off(eventNamespace).removeData(moduleNamespace);
              ;
              $menu.off(eventNamespace);
              ;
              $document.off(elementNamespace);
              ;
              if (selectObserver) {
                selectObserver.disconnect();
              }
              if (menuObserver) {
                menuObserver.disconnect();
              }
            },
            observeChanges: function() {
              if ('MutationObserver' in window) {
                selectObserver = new MutationObserver(function(mutations) {
                  module.debug('<select> modified, recreating menu');
                  module.setup.select();
                });
                menuObserver = new MutationObserver(function(mutations) {
                  module.debug('Menu modified, updating selector cache');
                  module.refresh();
                });
                if (module.has.input()) {
                  selectObserver.observe($input[0], {
                    childList: true,
                    subtree: true
                  });
                }
                if (module.has.menu()) {
                  menuObserver.observe($menu[0], {
                    childList: true,
                    subtree: true
                  });
                }
                module.debug('Setting up mutation observer', selectObserver, menuObserver);
              }
            },
            create: {
              id: function() {
                id = (Math.random().toString(16) + '000000000').substr(2, 8);
                elementNamespace = '.' + id;
                module.verbose('Creating unique id for element', id);
              },
              userChoice: function(values) {
                var $userChoices,
                    $userChoice,
                    isUserValue,
                    html;
                ;
                values = values || module.get.userValues();
                if (!values) {
                  return false;
                }
                values = $.isArray(values) ? values : [values];
                ;
                $.each(values, function(index, value) {
                  if (module.get.item(value) === false) {
                    html = settings.templates.addition(module.add.variables(message.addResult, value));
                    $userChoice = $('<div />').html(html).attr('data-' + metadata.value, value).attr('data-' + metadata.text, value).addClass(className.addition).addClass(className.item);
                    ;
                    $userChoices = ($userChoices === undefined) ? $userChoice : $userChoices.add($userChoice);
                    ;
                    module.verbose('Creating user choices for value', value, $userChoice);
                  }
                });
                return $userChoices;
              },
              userLabels: function(value) {
                var userValues = module.get.userValues();
                ;
                if (userValues) {
                  module.debug('Adding user labels', userValues);
                  $.each(userValues, function(index, value) {
                    module.verbose('Adding custom user value');
                    module.add.label(value, value);
                  });
                }
              },
              menu: function() {
                $menu = $('<div />').addClass(className.menu).appendTo($module);
                ;
              }
            },
            search: function(query) {
              query = (query !== undefined) ? query : module.get.query();
              ;
              module.verbose('Searching for query', query);
              module.filter(query);
            },
            select: {
              firstUnfiltered: function() {
                module.verbose('Selecting first non-filtered element');
                module.remove.selectedItem();
                $item.not(selector.unselectable).eq(0).addClass(className.selected);
                ;
              },
              nextAvailable: function($selected) {
                $selected = $selected.eq(0);
                var $nextAvailable = $selected.nextAll(selector.item).not(selector.unselectable).eq(0),
                    $prevAvailable = $selected.prevAll(selector.item).not(selector.unselectable).eq(0),
                    hasNext = ($nextAvailable.length > 0);
                ;
                if (hasNext) {
                  module.verbose('Moving selection to', $nextAvailable);
                  $nextAvailable.addClass(className.selected);
                } else {
                  module.verbose('Moving selection to', $prevAvailable);
                  $prevAvailable.addClass(className.selected);
                }
              }
            },
            setup: {
              api: function() {
                var apiSettings = {
                  debug: settings.debug,
                  on: false
                };
                ;
                module.verbose('First request, initializing API');
                $module.api(apiSettings);
                ;
              },
              layout: function() {
                if ($module.is('select')) {
                  module.setup.select();
                  module.setup.returnedObject();
                }
                if (!module.has.menu()) {
                  module.create.menu();
                }
                if (module.is.search() && !module.has.search()) {
                  module.verbose('Adding search input');
                  $search = $('<input />').addClass(className.search).insertBefore($text);
                  ;
                }
                if (settings.allowTab) {
                  module.set.tabbable();
                }
              },
              select: function() {
                var selectValues = module.get.selectValues();
                ;
                module.debug('Dropdown initialized on a select', selectValues);
                if ($module.is('select')) {
                  $input = $module;
                }
                if ($input.parent(selector.dropdown).length > 0) {
                  module.debug('UI dropdown already exists. Creating dropdown menu only');
                  $module = $input.closest(selector.dropdown);
                  if (!module.has.menu()) {
                    module.create.menu();
                  }
                  $menu = $module.children(selector.menu);
                  module.setup.menu(selectValues);
                } else {
                  module.debug('Creating entire dropdown from select');
                  $module = $('<div />').attr('class', $input.attr('class')).addClass(className.selection).addClass(className.dropdown).html(templates.dropdown(selectValues)).insertBefore($input);
                  ;
                  if ($input.hasClass(className.multiple) && $input.prop('multiple') === false) {
                    module.error(error.missingMultiple);
                    $input.prop('multiple', true);
                  }
                  if ($input.is('[multiple]')) {
                    module.set.multiple();
                  }
                  if ($input.prop('disabled')) {
                    module.debug('Disabling dropdown');
                    $module.addClass(className.disabled);
                  }
                  $input.removeAttr('class').detach().prependTo($module);
                  ;
                }
                module.refresh();
              },
              menu: function(values) {
                $menu.html(templates.menu(values, fields));
                $item = $menu.find(selector.item);
              },
              reference: function() {
                module.debug('Dropdown behavior was called on select, replacing with closest dropdown');
                $module = $module.parent(selector.dropdown);
                module.refresh();
                module.setup.returnedObject();
                if (methodInvoked) {
                  instance = module;
                  module.invoke(query);
                }
              },
              returnedObject: function() {
                var $firstModules = $allModules.slice(0, elementIndex),
                    $lastModules = $allModules.slice(elementIndex + 1);
                ;
                $allModules = $firstModules.add($module).add($lastModules);
              }
            },
            refresh: function() {
              module.refreshSelectors();
              module.refreshData();
            },
            refreshSelectors: function() {
              module.verbose('Refreshing selector cache');
              $text = $module.find(selector.text);
              $search = $module.find(selector.search);
              $input = $module.find(selector.input);
              $icon = $module.find(selector.icon);
              $combo = ($module.prev().find(selector.text).length > 0) ? $module.prev().find(selector.text) : $module.prev();
              ;
              $menu = $module.children(selector.menu);
              $item = $menu.find(selector.item);
            },
            refreshData: function() {
              module.verbose('Refreshing cached metadata');
              $item.removeData(metadata.text).removeData(metadata.value);
              ;
              $module.removeData(metadata.defaultText).removeData(metadata.defaultValue).removeData(metadata.placeholderText);
              ;
            },
            toggle: function() {
              module.verbose('Toggling menu visibility');
              if (!module.is.active()) {
                module.show();
              } else {
                module.hide();
              }
            },
            show: function(callback) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              if (module.can.show() && !module.is.active()) {
                module.debug('Showing dropdown');
                if (module.is.multiple() && !module.has.search() && module.is.allFiltered()) {
                  return true;
                }
                if (module.has.message() && !module.has.maxSelections()) {
                  module.remove.message();
                }
                if (settings.onShow.call(element) !== false) {
                  module.animate.show(function() {
                    if (module.can.click()) {
                      module.bind.intent();
                    }
                    module.set.visible();
                    callback.call(element);
                  });
                }
              }
            },
            hide: function(callback) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              if (module.is.active()) {
                module.debug('Hiding dropdown');
                if (settings.onHide.call(element) !== false) {
                  module.animate.hide(function() {
                    module.remove.visible();
                    callback.call(element);
                  });
                }
              }
            },
            hideOthers: function() {
              module.verbose('Finding other dropdowns to hide');
              $allModules.not($module).has(selector.menu + '.' + className.visible).dropdown('hide');
              ;
            },
            hideMenu: function() {
              module.verbose('Hiding menu  instantaneously');
              module.remove.active();
              module.remove.visible();
              $menu.transition('hide');
            },
            hideSubMenus: function() {
              var $subMenus = $menu.children(selector.item).find(selector.menu);
              ;
              module.verbose('Hiding sub menus', $subMenus);
              $subMenus.transition('hide');
            },
            bind: {
              events: function() {
                if (hasTouch) {
                  module.bind.touchEvents();
                }
                module.bind.keyboardEvents();
                module.bind.inputEvents();
                module.bind.mouseEvents();
              },
              touchEvents: function() {
                module.debug('Touch device detected binding additional touch events');
                if (module.is.searchSelection()) {} else if (module.is.single()) {
                  $module.on('touchstart' + eventNamespace, module.event.test.toggle);
                  ;
                }
                $menu.on('touchstart' + eventNamespace, selector.item, module.event.item.mouseenter);
                ;
              },
              keyboardEvents: function() {
                module.verbose('Binding keyboard events');
                $module.on('keydown' + eventNamespace, module.event.keydown);
                ;
                if (module.has.search()) {
                  $module.on(module.get.inputEvent() + eventNamespace, selector.search, module.event.input);
                  ;
                }
                if (module.is.multiple()) {
                  $document.on('keydown' + elementNamespace, module.event.document.keydown);
                  ;
                }
              },
              inputEvents: function() {
                module.verbose('Binding input change events');
                $module.on('change' + eventNamespace, selector.input, module.event.change);
                ;
              },
              mouseEvents: function() {
                module.verbose('Binding mouse events');
                if (module.is.multiple()) {
                  $module.on('click' + eventNamespace, selector.label, module.event.label.click).on('click' + eventNamespace, selector.remove, module.event.remove.click);
                  ;
                }
                if (module.is.searchSelection()) {
                  $module.on('mousedown' + eventNamespace, selector.menu, module.event.menu.mousedown).on('mouseup' + eventNamespace, selector.menu, module.event.menu.mouseup).on('click' + eventNamespace, selector.icon, module.event.icon.click).on('click' + eventNamespace, selector.search, module.show).on('focus' + eventNamespace, selector.search, module.event.search.focus).on('blur' + eventNamespace, selector.search, module.event.search.blur).on('click' + eventNamespace, selector.text, module.event.text.focus);
                  ;
                  if (module.is.multiple()) {
                    $module.on('click' + eventNamespace, module.event.click);
                    ;
                  }
                } else {
                  if (settings.on == 'click') {
                    $module.on('click' + eventNamespace, selector.icon, module.event.icon.click).on('click' + eventNamespace, module.event.test.toggle);
                    ;
                  } else if (settings.on == 'hover') {
                    $module.on('mouseenter' + eventNamespace, module.delay.show).on('mouseleave' + eventNamespace, module.delay.hide);
                    ;
                  } else {
                    $module.on(settings.on + eventNamespace, module.toggle);
                    ;
                  }
                  $module.on('mousedown' + eventNamespace, module.event.mousedown).on('mouseup' + eventNamespace, module.event.mouseup).on('focus' + eventNamespace, module.event.focus).on('blur' + eventNamespace, module.event.blur);
                  ;
                }
                $menu.on('mouseenter' + eventNamespace, selector.item, module.event.item.mouseenter).on('mouseleave' + eventNamespace, selector.item, module.event.item.mouseleave).on('click' + eventNamespace, selector.item, module.event.item.click);
                ;
              },
              intent: function() {
                module.verbose('Binding hide intent event to document');
                if (hasTouch) {
                  $document.on('touchstart' + elementNamespace, module.event.test.touch).on('touchmove' + elementNamespace, module.event.test.touch);
                  ;
                }
                $document.on('click' + elementNamespace, module.event.test.hide);
                ;
              }
            },
            unbind: {intent: function() {
                module.verbose('Removing hide intent event from document');
                if (hasTouch) {
                  $document.off('touchstart' + elementNamespace).off('touchmove' + elementNamespace);
                  ;
                }
                $document.off('click' + elementNamespace);
                ;
              }},
            filter: function(query) {
              var searchTerm = (query !== undefined) ? query : module.get.query(),
                  afterFiltered = function() {
                    if (module.is.multiple()) {
                      module.filterActive();
                    }
                    module.select.firstUnfiltered();
                    if (module.has.allResultsFiltered()) {
                      if (settings.onNoResults.call(element, searchTerm)) {
                        if (!settings.allowAdditions) {
                          module.verbose('All items filtered, showing message', searchTerm);
                          module.add.message(message.noResults);
                        }
                      } else {
                        module.verbose('All items filtered, hiding dropdown', searchTerm);
                        module.hideMenu();
                      }
                    } else {
                      module.remove.message();
                    }
                    if (settings.allowAdditions) {
                      module.add.userSuggestion(query);
                    }
                    if (module.is.searchSelection() && module.can.show() && module.is.focusedOnSearch()) {
                      module.show();
                    }
                  };
              ;
              if (settings.useLabels && module.has.maxSelections()) {
                return;
              }
              if (settings.apiSettings) {
                if (module.can.useAPI()) {
                  module.queryRemote(searchTerm, function() {
                    afterFiltered();
                  });
                } else {
                  module.error(error.noAPI);
                }
              } else {
                module.filterItems(searchTerm);
                afterFiltered();
              }
            },
            queryRemote: function(query, callback) {
              var apiSettings = {
                errorDuration: false,
                throttle: settings.throttle,
                urlData: {query: query},
                onError: function() {
                  module.add.message(message.serverError);
                  callback();
                },
                onFailure: function() {
                  module.add.message(message.serverError);
                  callback();
                },
                onSuccess: function(response) {
                  module.remove.message();
                  module.setup.menu({values: response.results});
                  callback();
                }
              };
              ;
              if (!$module.api('get request')) {
                module.setup.api();
              }
              apiSettings = $.extend(true, {}, apiSettings, settings.apiSettings);
              $module.api('setting', apiSettings).api('query');
              ;
            },
            filterItems: function(query) {
              var searchTerm = (query !== undefined) ? query : module.get.query(),
                  $results = $(),
                  escapedTerm = module.escape.regExp(searchTerm),
                  beginsWithRegExp = new RegExp('^' + escapedTerm, 'igm');
              ;
              if (!module.has.query()) {
                $results = $item;
              } else {
                module.verbose('Searching for matching values', searchTerm);
                $item.each(function() {
                  var $choice = $(this),
                      text,
                      value;
                  ;
                  if (settings.match == 'both' || settings.match == 'text') {
                    text = String(module.get.choiceText($choice, false));
                    if (text.search(beginsWithRegExp) !== -1) {
                      $results = $results.add($choice);
                      return true;
                    } else if (settings.fullTextSearch && module.fuzzySearch(searchTerm, text)) {
                      $results = $results.add($choice);
                      return true;
                    }
                  }
                  if (settings.match == 'both' || settings.match == 'value') {
                    value = String(module.get.choiceValue($choice, text));
                    if (value.search(beginsWithRegExp) !== -1) {
                      $results = $results.add($choice);
                      return true;
                    } else if (settings.fullTextSearch && module.fuzzySearch(searchTerm, value)) {
                      $results = $results.add($choice);
                      return true;
                    }
                  }
                });
                ;
              }
              module.debug('Showing only matched items', searchTerm);
              module.remove.filteredItem();
              $item.not($results).addClass(className.filtered);
              ;
            },
            fuzzySearch: function(query, term) {
              var termLength = term.length,
                  queryLength = query.length;
              ;
              query = query.toLowerCase();
              term = term.toLowerCase();
              if (queryLength > termLength) {
                return false;
              }
              if (queryLength === termLength) {
                return (query === term);
              }
              search: for (var characterIndex = 0,
                  nextCharacterIndex = 0; characterIndex < queryLength; characterIndex++) {
                var queryCharacter = query.charCodeAt(characterIndex);
                ;
                while (nextCharacterIndex < termLength) {
                  if (term.charCodeAt(nextCharacterIndex++) === queryCharacter) {
                    continue search;
                  }
                }
                return false;
              }
              return true;
            },
            filterActive: function() {
              if (settings.useLabels) {
                $item.filter('.' + className.active).addClass(className.filtered);
                ;
              }
            },
            focusSearch: function() {
              if (module.is.search() && !module.is.focusedOnSearch()) {
                $search[0].focus();
              }
            },
            forceSelection: function() {
              var $currentlySelected = $item.not(className.filtered).filter('.' + className.selected).eq(0),
                  $activeItem = $item.not(className.filtered).filter('.' + className.active).eq(0),
                  $selectedItem = ($currentlySelected.length > 0) ? $currentlySelected : $activeItem,
                  hasSelected = ($selectedItem.size() > 0);
              ;
              if (hasSelected && module.has.query()) {
                module.debug('Forcing partial selection to selected item', $selectedItem);
                module.event.item.click.call($selectedItem);
              } else {
                module.hide();
              }
            },
            event: {
              change: function() {
                if (!internalChange) {
                  module.debug('Input changed, updating selection');
                  module.set.selected();
                }
              },
              focus: function() {
                if (settings.showOnFocus && !activated && module.is.hidden() && !pageLostFocus) {
                  module.show();
                }
              },
              click: function(event) {
                var $target = $(event.target);
                ;
                if ($target.is($module) && !module.is.focusedOnSearch()) {
                  module.focusSearch();
                }
              },
              blur: function(event) {
                pageLostFocus = (document.activeElement === this);
                if (!activated && !pageLostFocus) {
                  module.remove.activeLabel();
                  module.hide();
                }
              },
              mousedown: function() {
                activated = true;
              },
              mouseup: function() {
                activated = false;
              },
              search: {
                focus: function() {
                  activated = true;
                  if (module.is.multiple()) {
                    module.remove.activeLabel();
                  }
                  if (settings.showOnFocus) {
                    module.show();
                  }
                },
                blur: function(event) {
                  pageLostFocus = (document.activeElement === this);
                  if (!itemActivated && !pageLostFocus) {
                    if (module.is.multiple()) {
                      module.remove.activeLabel();
                      module.hide();
                    } else if (settings.forceSelection) {
                      module.forceSelection();
                    } else {
                      module.hide();
                    }
                  } else if (pageLostFocus) {
                    if (settings.forceSelection) {
                      module.forceSelection();
                    }
                  }
                }
              },
              icon: {click: function(event) {
                  module.toggle();
                  event.stopPropagation();
                }},
              text: {focus: function(event) {
                  activated = true;
                  module.focusSearch();
                }},
              input: function(event) {
                if (module.is.multiple() || module.is.searchSelection()) {
                  module.set.filtered();
                }
                clearTimeout(module.timer);
                module.timer = setTimeout(module.search, settings.delay.search);
              },
              label: {click: function(event) {
                  var $label = $(this),
                      $labels = $module.find(selector.label),
                      $activeLabels = $labels.filter('.' + className.active),
                      $nextActive = $label.nextAll('.' + className.active),
                      $prevActive = $label.prevAll('.' + className.active),
                      $range = ($nextActive.length > 0) ? $label.nextUntil($nextActive).add($activeLabels).add($label) : $label.prevUntil($prevActive).add($activeLabels).add($label);
                  ;
                  if (event.shiftKey) {
                    $activeLabels.removeClass(className.active);
                    $range.addClass(className.active);
                  } else if (event.ctrlKey) {
                    $label.toggleClass(className.active);
                  } else {
                    $activeLabels.removeClass(className.active);
                    $label.addClass(className.active);
                  }
                  settings.onLabelSelect.apply(this, $labels.filter('.' + className.active));
                }},
              remove: {click: function() {
                  var $label = $(this).parent();
                  ;
                  if ($label.hasClass(className.active)) {
                    module.remove.activeLabels();
                  } else {
                    module.remove.activeLabels($label);
                  }
                }},
              test: {
                toggle: function(event) {
                  var toggleBehavior = (module.is.multiple()) ? module.show : module.toggle;
                  ;
                  if (module.determine.eventOnElement(event, toggleBehavior)) {
                    event.preventDefault();
                  }
                },
                touch: function(event) {
                  module.determine.eventOnElement(event, function() {
                    if (event.type == 'touchstart') {
                      module.timer = setTimeout(function() {
                        module.hide();
                      }, settings.delay.touch);
                    } else if (event.type == 'touchmove') {
                      clearTimeout(module.timer);
                    }
                  });
                  event.stopPropagation();
                },
                hide: function(event) {
                  module.determine.eventInModule(event, module.hide);
                }
              },
              menu: {
                mousedown: function() {
                  itemActivated = true;
                },
                mouseup: function() {
                  itemActivated = false;
                }
              },
              item: {
                mouseenter: function(event) {
                  var $subMenu = $(this).children(selector.menu),
                      $otherMenus = $(this).siblings(selector.item).children(selector.menu);
                  ;
                  if ($subMenu.length > 0) {
                    clearTimeout(module.itemTimer);
                    module.itemTimer = setTimeout(function() {
                      module.verbose('Showing sub-menu', $subMenu);
                      $.each($otherMenus, function() {
                        module.animate.hide(false, $(this));
                      });
                      module.animate.show(false, $subMenu);
                    }, settings.delay.show);
                    event.preventDefault();
                  }
                },
                mouseleave: function(event) {
                  var $subMenu = $(this).children(selector.menu);
                  ;
                  if ($subMenu.length > 0) {
                    clearTimeout(module.itemTimer);
                    module.itemTimer = setTimeout(function() {
                      module.verbose('Hiding sub-menu', $subMenu);
                      module.animate.hide(false, $subMenu);
                    }, settings.delay.hide);
                  }
                },
                touchend: function() {},
                click: function(event) {
                  var $choice = $(this),
                      $target = (event) ? $(event.target) : $(''),
                      $subMenu = $choice.find(selector.menu),
                      text = module.get.choiceText($choice),
                      value = module.get.choiceValue($choice, text),
                      hasSubMenu = ($subMenu.length > 0),
                      isBubbledEvent = ($subMenu.find($target).length > 0);
                  ;
                  if (!isBubbledEvent && (!hasSubMenu || settings.allowCategorySelection)) {
                    if (!settings.useLabels) {
                      module.remove.filteredItem();
                      module.remove.searchTerm();
                      module.set.scrollPosition($choice);
                    }
                    module.determine.selectAction.call(this, text, value);
                  }
                }
              },
              document: {keydown: function(event) {
                  var pressedKey = event.which,
                      keys = module.get.shortcutKeys(),
                      isShortcutKey = module.is.inObject(pressedKey, keys);
                  ;
                  if (isShortcutKey) {
                    var $label = $module.find(selector.label),
                        $activeLabel = $label.filter('.' + className.active),
                        activeValue = $activeLabel.data(metadata.value),
                        labelIndex = $label.index($activeLabel),
                        labelCount = $label.length,
                        hasActiveLabel = ($activeLabel.length > 0),
                        hasMultipleActive = ($activeLabel.length > 1),
                        isFirstLabel = (labelIndex === 0),
                        isLastLabel = (labelIndex + 1 == labelCount),
                        isSearch = module.is.searchSelection(),
                        isFocusedOnSearch = module.is.focusedOnSearch(),
                        isFocused = module.is.focused(),
                        caretAtStart = (isFocusedOnSearch && module.get.caretPosition() === 0),
                        $nextLabel;
                    ;
                    if (isSearch && !hasActiveLabel && !isFocusedOnSearch) {
                      return;
                    }
                    if (pressedKey == keys.leftArrow) {
                      if ((isFocused || caretAtStart) && !hasActiveLabel) {
                        module.verbose('Selecting previous label');
                        $label.last().addClass(className.active);
                      } else if (hasActiveLabel) {
                        if (!event.shiftKey) {
                          module.verbose('Selecting previous label');
                          $label.removeClass(className.active);
                        } else {
                          module.verbose('Adding previous label to selection');
                        }
                        if (isFirstLabel && !hasMultipleActive) {
                          $activeLabel.addClass(className.active);
                        } else {
                          $activeLabel.prev(selector.siblingLabel).addClass(className.active).end();
                          ;
                        }
                        event.preventDefault();
                      }
                    } else if (pressedKey == keys.rightArrow) {
                      if (isFocused && !hasActiveLabel) {
                        $label.first().addClass(className.active);
                      }
                      if (hasActiveLabel) {
                        if (!event.shiftKey) {
                          module.verbose('Selecting next label');
                          $label.removeClass(className.active);
                        } else {
                          module.verbose('Adding next label to selection');
                        }
                        if (isLastLabel) {
                          if (isSearch) {
                            if (!isFocusedOnSearch) {
                              module.focusSearch();
                            } else {
                              $label.removeClass(className.active);
                            }
                          } else if (hasMultipleActive) {
                            $activeLabel.next(selector.siblingLabel).addClass(className.active);
                          } else {
                            $activeLabel.addClass(className.active);
                          }
                        } else {
                          $activeLabel.next(selector.siblingLabel).addClass(className.active);
                        }
                        event.preventDefault();
                      }
                    } else if (pressedKey == keys.deleteKey || pressedKey == keys.backspace) {
                      if (hasActiveLabel) {
                        module.verbose('Removing active labels');
                        if (isLastLabel) {
                          if (isSearch && !isFocusedOnSearch) {
                            module.focusSearch();
                          }
                        }
                        $activeLabel.last().next(selector.siblingLabel).addClass(className.active);
                        module.remove.activeLabels($activeLabel);
                        event.preventDefault();
                      } else if (caretAtStart && !hasActiveLabel && pressedKey == keys.backspace) {
                        module.verbose('Removing last label on input backspace');
                        $activeLabel = $label.last().addClass(className.active);
                        module.remove.activeLabels($activeLabel);
                      }
                    } else {
                      $activeLabel.removeClass(className.active);
                    }
                  }
                }},
              keydown: function(event) {
                var pressedKey = event.which,
                    keys = module.get.shortcutKeys(),
                    isShortcutKey = module.is.inObject(pressedKey, keys);
                ;
                if (isShortcutKey) {
                  var $currentlySelected = $item.not(selector.unselectable).filter('.' + className.selected).eq(0),
                      $activeItem = $menu.children('.' + className.active).eq(0),
                      $selectedItem = ($currentlySelected.length > 0) ? $currentlySelected : $activeItem,
                      $visibleItems = ($selectedItem.length > 0) ? $selectedItem.siblings(':not(.' + className.filtered + ')').andSelf() : $menu.children(':not(.' + className.filtered + ')'),
                      $subMenu = $selectedItem.children(selector.menu),
                      $parentMenu = $selectedItem.closest(selector.menu),
                      inVisibleMenu = ($parentMenu.hasClass(className.visible) || $parentMenu.hasClass(className.animating) || $parentMenu.parent(selector.menu).length > 0),
                      hasSubMenu = ($subMenu.length > 0),
                      hasSelectedItem = ($selectedItem.length > 0),
                      selectedIsSelectable = ($selectedItem.not(selector.unselectable).length > 0),
                      delimiterPressed = (pressedKey == keys.delimiter && settings.allowAdditions && module.is.multiple()),
                      $nextItem,
                      isSubMenuItem,
                      newIndex;
                  ;
                  if (module.is.visible()) {
                    if (pressedKey == keys.enter || delimiterPressed) {
                      if (pressedKey == keys.enter && hasSelectedItem && hasSubMenu && !settings.allowCategorySelection) {
                        module.verbose('Pressed enter on unselectable category, opening sub menu');
                        pressedKey = keys.rightArrow;
                      } else if (selectedIsSelectable) {
                        module.verbose('Selecting item from keyboard shortcut', $selectedItem);
                        module.event.item.click.call($selectedItem, event);
                        if (module.is.searchSelection()) {
                          module.remove.searchTerm();
                        }
                      }
                      event.preventDefault();
                    }
                    if (pressedKey == keys.leftArrow) {
                      isSubMenuItem = ($parentMenu[0] !== $menu[0]);
                      if (isSubMenuItem) {
                        module.verbose('Left key pressed, closing sub-menu');
                        module.animate.hide(false, $parentMenu);
                        $selectedItem.removeClass(className.selected);
                        ;
                        $parentMenu.closest(selector.item).addClass(className.selected);
                        ;
                        event.preventDefault();
                      }
                    }
                    if (pressedKey == keys.rightArrow) {
                      if (hasSubMenu) {
                        module.verbose('Right key pressed, opening sub-menu');
                        module.animate.show(false, $subMenu);
                        $selectedItem.removeClass(className.selected);
                        ;
                        $subMenu.find(selector.item).eq(0).addClass(className.selected);
                        ;
                        event.preventDefault();
                      }
                    }
                    if (pressedKey == keys.upArrow) {
                      $nextItem = (hasSelectedItem && inVisibleMenu) ? $selectedItem.prevAll(selector.item + ':not(' + selector.unselectable + ')').eq(0) : $item.eq(0);
                      ;
                      if ($visibleItems.index($nextItem) < 0) {
                        module.verbose('Up key pressed but reached top of current menu');
                        event.preventDefault();
                        return;
                      } else {
                        module.verbose('Up key pressed, changing active item');
                        $selectedItem.removeClass(className.selected);
                        ;
                        $nextItem.addClass(className.selected);
                        ;
                        module.set.scrollPosition($nextItem);
                      }
                      event.preventDefault();
                    }
                    if (pressedKey == keys.downArrow) {
                      $nextItem = (hasSelectedItem && inVisibleMenu) ? $nextItem = $selectedItem.nextAll(selector.item + ':not(' + selector.unselectable + ')').eq(0) : $item.eq(0);
                      ;
                      if ($nextItem.length === 0) {
                        module.verbose('Down key pressed but reached bottom of current menu');
                        event.preventDefault();
                        return;
                      } else {
                        module.verbose('Down key pressed, changing active item');
                        $item.removeClass(className.selected);
                        ;
                        $nextItem.addClass(className.selected);
                        ;
                        module.set.scrollPosition($nextItem);
                      }
                      event.preventDefault();
                    }
                    if (pressedKey == keys.pageUp) {
                      module.scrollPage('up');
                      event.preventDefault();
                    }
                    if (pressedKey == keys.pageDown) {
                      module.scrollPage('down');
                      event.preventDefault();
                    }
                    if (pressedKey == keys.escape) {
                      module.verbose('Escape key pressed, closing dropdown');
                      module.hide();
                    }
                  } else {
                    if (delimiterPressed) {
                      event.preventDefault();
                    }
                    if (pressedKey == keys.downArrow) {
                      module.verbose('Down key pressed, showing dropdown');
                      module.show();
                      event.preventDefault();
                    }
                  }
                } else {
                  if (module.is.selection() && !module.is.search()) {
                    module.set.selectedLetter(String.fromCharCode(pressedKey));
                  }
                }
              }
            },
            determine: {
              selectAction: function(text, value) {
                module.verbose('Determining action', settings.action);
                if ($.isFunction(module.action[settings.action])) {
                  module.verbose('Triggering preset action', settings.action, text, value);
                  module.action[settings.action].call(this, text, value);
                } else if ($.isFunction(settings.action)) {
                  module.verbose('Triggering user action', settings.action, text, value);
                  settings.action.call(this, text, value);
                } else {
                  module.error(error.action, settings.action);
                }
              },
              eventInModule: function(event, callback) {
                var $target = $(event.target),
                    inDocument = ($target.closest(document.documentElement).length > 0),
                    inModule = ($target.closest($module).length > 0);
                ;
                callback = $.isFunction(callback) ? callback : function() {};
                ;
                if (inDocument && !inModule) {
                  module.verbose('Triggering event', callback);
                  callback();
                  return true;
                } else {
                  module.verbose('Event occurred in dropdown, canceling callback');
                  return false;
                }
              },
              eventOnElement: function(event, callback) {
                var $target = $(event.target),
                    $label = $target.closest(selector.siblingLabel),
                    notOnLabel = ($module.find($label).length === 0),
                    notInMenu = ($target.closest($menu).length === 0);
                ;
                callback = $.isFunction(callback) ? callback : function() {};
                ;
                if (notOnLabel && notInMenu) {
                  module.verbose('Triggering event', callback);
                  callback();
                  return true;
                } else {
                  module.verbose('Event occurred in dropdown menu, canceling callback');
                  return false;
                }
              }
            },
            action: {
              nothing: function() {},
              activate: function(text, value) {
                value = (value !== undefined) ? value : text;
                ;
                if (module.can.activate($(this))) {
                  module.set.selected(value, $(this));
                  if (module.is.multiple() && !module.is.allFiltered()) {
                    return;
                  } else {
                    module.hideAndClear();
                  }
                }
              },
              select: function(text, value) {
                module.action.activate.call(this);
              },
              combo: function(text, value) {
                value = (value !== undefined) ? value : text;
                ;
                module.set.selected(value, $(this));
                module.hideAndClear();
              },
              hide: function(text, value) {
                module.set.value(value);
                module.hideAndClear();
              }
            },
            get: {
              id: function() {
                return id;
              },
              defaultText: function() {
                return $module.data(metadata.defaultText);
              },
              defaultValue: function() {
                return $module.data(metadata.defaultValue);
              },
              placeholderText: function() {
                return $module.data(metadata.placeholderText) || '';
              },
              text: function() {
                return $text.text();
              },
              query: function() {
                return $.trim($search.val());
              },
              searchWidth: function(characterCount) {
                return (characterCount * settings.glyphWidth) + 'em';
              },
              selectionCount: function() {
                var values = module.get.values(),
                    count;
                ;
                count = (module.is.multiple()) ? $.isArray(values) ? values.length : 0 : (module.get.value() !== '') ? 1 : 0;
                ;
                return count;
              },
              transition: function($subMenu) {
                return (settings.transition == 'auto') ? module.is.upward($subMenu) ? 'slide up' : 'slide down' : settings.transition;
                ;
              },
              userValues: function() {
                var values = module.get.values();
                ;
                if (!values) {
                  return false;
                }
                values = $.isArray(values) ? values : [values];
                ;
                return $.grep(values, function(value) {
                  return (module.get.item(value) === false);
                });
              },
              uniqueArray: function(array) {
                return $.grep(array, function(value, index) {
                  return $.inArray(value, array) === index;
                });
              },
              caretPosition: function() {
                var input = $search.get(0),
                    range,
                    rangeLength;
                ;
                if ('selectionStart' in input) {
                  return input.selectionStart;
                } else if (document.selection) {
                  input.focus();
                  range = document.selection.createRange();
                  rangeLength = range.text.length;
                  range.moveStart('character', -input.value.length);
                  return range.text.length - rangeLength;
                }
              },
              shortcutKeys: function() {
                return {
                  backspace: 8,
                  delimiter: 188,
                  deleteKey: 46,
                  enter: 13,
                  escape: 27,
                  pageUp: 33,
                  pageDown: 34,
                  leftArrow: 37,
                  upArrow: 38,
                  rightArrow: 39,
                  downArrow: 40
                };
              },
              value: function() {
                var value = ($input.length > 0) ? $input.val() : $module.data(metadata.value);
                ;
                if ($.isArray(value) && value.length === 1 && value[0] === '') {
                  return '';
                }
                return value;
              },
              values: function() {
                var value = module.get.value();
                ;
                if (value === '') {
                  return '';
                }
                return (!module.has.selectInput() && module.is.multiple()) ? (typeof value == 'string') ? value.split(settings.delimiter) : '' : value;
                ;
              },
              remoteValues: function() {
                var values = module.get.values(),
                    remoteValues = false;
                ;
                if (values) {
                  if (typeof values == 'string') {
                    values = [values];
                  }
                  remoteValues = {};
                  $.each(values, function(index, value) {
                    var name = module.read.remoteData(value);
                    ;
                    module.verbose('Restoring value from session data', name, value);
                    remoteValues[value] = (name) ? name : value;
                    ;
                  });
                }
                return remoteValues;
              },
              choiceText: function($choice, preserveHTML) {
                preserveHTML = (preserveHTML !== undefined) ? preserveHTML : settings.preserveHTML;
                ;
                if ($choice) {
                  if ($choice.find(selector.menu).length > 0) {
                    module.verbose('Retreiving text of element with sub-menu');
                    $choice = $choice.clone();
                    $choice.find(selector.menu).remove();
                    $choice.find(selector.menuIcon).remove();
                  }
                  return ($choice.data(metadata.text) !== undefined) ? $choice.data(metadata.text) : (preserveHTML) ? $.trim($choice.html()) : $.trim($choice.text());
                  ;
                }
              },
              choiceValue: function($choice, choiceText) {
                choiceText = choiceText || module.get.choiceText($choice);
                if (!$choice) {
                  return false;
                }
                return ($choice.data(metadata.value) !== undefined) ? String($choice.data(metadata.value)) : (typeof choiceText === 'string') ? $.trim(choiceText.toLowerCase()) : String(choiceText);
                ;
              },
              inputEvent: function() {
                var input = $search[0];
                ;
                if (input) {
                  return (input.oninput !== undefined) ? 'input' : (input.onpropertychange !== undefined) ? 'propertychange' : 'keyup';
                  ;
                }
                return false;
              },
              selectValues: function() {
                var select = {};
                ;
                select.values = [];
                $module.find('option').each(function() {
                  var $option = $(this),
                      name = $option.html(),
                      disabled = $option.attr('disabled'),
                      value = ($option.attr('value') !== undefined) ? $option.attr('value') : name;
                  ;
                  if (settings.placeholder === 'auto' && value === '') {
                    select.placeholder = name;
                  } else {
                    select.values.push({
                      name: name,
                      value: value,
                      disabled: disabled
                    });
                  }
                });
                ;
                if (settings.placeholder && settings.placeholder !== 'auto') {
                  module.debug('Setting placeholder value to', settings.placeholder);
                  select.placeholder = settings.placeholder;
                }
                if (settings.sortSelect) {
                  select.values.sort(function(a, b) {
                    return (a.name > b.name) ? 1 : -1;
                    ;
                  });
                  module.debug('Retrieved and sorted values from select', select);
                } else {
                  module.debug('Retreived values from select', select);
                }
                return select;
              },
              activeItem: function() {
                return $item.filter('.' + className.active);
              },
              selectedItem: function() {
                var $selectedItem = $item.not(selector.unselectable).filter('.' + className.selected);
                ;
                return ($selectedItem.length > 0) ? $selectedItem : $item.eq(0);
                ;
              },
              itemWithAdditions: function(value) {
                var $items = module.get.item(value),
                    $userItems = module.create.userChoice(value),
                    hasUserItems = ($userItems && $userItems.length > 0);
                ;
                if (hasUserItems) {
                  $items = ($items.length > 0) ? $items.add($userItems) : $userItems;
                  ;
                }
                return $items;
              },
              item: function(value, strict) {
                var $selectedItem = false,
                    shouldSearch,
                    isMultiple;
                ;
                value = (value !== undefined) ? value : (module.get.values() !== undefined) ? module.get.values() : module.get.text();
                ;
                shouldSearch = (isMultiple) ? (value.length > 0) : (value !== undefined && value !== null);
                ;
                isMultiple = (module.is.multiple() && $.isArray(value));
                strict = (value === '' || value === 0) ? true : strict || false;
                ;
                if (shouldSearch) {
                  $item.each(function() {
                    var $choice = $(this),
                        optionText = module.get.choiceText($choice),
                        optionValue = module.get.choiceValue($choice, optionText);
                    ;
                    if (optionValue === null || optionValue === undefined) {
                      return;
                    }
                    if (isMultiple) {
                      if ($.inArray(String(optionValue), value) !== -1 || $.inArray(optionText, value) !== -1) {
                        $selectedItem = ($selectedItem) ? $selectedItem.add($choice) : $choice;
                        ;
                      }
                    } else if (strict) {
                      module.verbose('Ambiguous dropdown value using strict type check', $choice, value);
                      if (optionValue === value || optionText === value) {
                        $selectedItem = $choice;
                        return true;
                      }
                    } else {
                      if (String(optionValue) == String(value) || optionText == value) {
                        module.verbose('Found select item by value', optionValue, value);
                        $selectedItem = $choice;
                        return true;
                      }
                    }
                  });
                  ;
                }
                return $selectedItem;
              }
            },
            check: {maxSelections: function(selectionCount) {
                if (settings.maxSelections) {
                  selectionCount = (selectionCount !== undefined) ? selectionCount : module.get.selectionCount();
                  ;
                  if (selectionCount >= settings.maxSelections) {
                    module.debug('Maximum selection count reached');
                    if (settings.useLabels) {
                      $item.addClass(className.filtered);
                      module.add.message(message.maxSelections);
                    }
                    return true;
                  } else {
                    module.verbose('No longer at maximum selection count');
                    module.remove.message();
                    module.remove.filteredItem();
                    if (module.is.searchSelection()) {
                      module.filterItems();
                    }
                    return false;
                  }
                }
                return true;
              }},
            restore: {
              defaults: function() {
                module.clear();
                module.restore.defaultText();
                module.restore.defaultValue();
              },
              defaultText: function() {
                var defaultText = module.get.defaultText(),
                    placeholderText = module.get.placeholderText;
                ;
                if (defaultText === placeholderText) {
                  module.debug('Restoring default placeholder text', defaultText);
                  module.set.placeholderText(defaultText);
                } else {
                  module.debug('Restoring default text', defaultText);
                  module.set.text(defaultText);
                }
              },
              defaultValue: function() {
                var defaultValue = module.get.defaultValue();
                ;
                if (defaultValue !== undefined) {
                  module.debug('Restoring default value', defaultValue);
                  if (defaultValue !== '') {
                    module.set.value(defaultValue);
                    module.set.selected();
                  } else {
                    module.remove.activeItem();
                    module.remove.selectedItem();
                  }
                }
              },
              labels: function() {
                if (settings.allowAdditions) {
                  if (!settings.useLabels) {
                    module.error(error.labels);
                    settings.useLabels = true;
                  }
                  module.debug('Restoring selected values');
                  module.create.userLabels();
                }
                module.check.maxSelections();
              },
              selected: function() {
                module.restore.values();
                if (module.is.multiple()) {
                  module.debug('Restoring previously selected values and labels');
                  module.restore.labels();
                } else {
                  module.debug('Restoring previously selected values');
                }
              },
              values: function() {
                module.set.initialLoad();
                if (settings.apiSettings) {
                  if (settings.saveRemoteData) {
                    module.restore.remoteValues();
                  } else {
                    module.clearValue();
                  }
                } else {
                  module.set.selected();
                }
                module.remove.initialLoad();
              },
              remoteValues: function() {
                var values = module.get.remoteValues();
                ;
                module.debug('Recreating selected from session data', values);
                if (values) {
                  if (module.is.single()) {
                    $.each(values, function(value, name) {
                      module.set.text(name);
                    });
                  } else {
                    $.each(values, function(value, name) {
                      module.add.label(value, name);
                    });
                  }
                }
              }
            },
            read: {remoteData: function(value) {
                var name;
                ;
                if (window.Storage === undefined) {
                  module.error(error.noStorage);
                  return;
                }
                name = sessionStorage.getItem(value);
                return (name !== undefined) ? name : false;
                ;
              }},
            save: {
              defaults: function() {
                module.save.defaultText();
                module.save.placeholderText();
                module.save.defaultValue();
              },
              defaultValue: function() {
                var value = module.get.value();
                ;
                module.verbose('Saving default value as', value);
                $module.data(metadata.defaultValue, value);
              },
              defaultText: function() {
                var text = module.get.text();
                ;
                module.verbose('Saving default text as', text);
                $module.data(metadata.defaultText, text);
              },
              placeholderText: function() {
                var text;
                ;
                if (settings.placeholder !== false && $text.hasClass(className.placeholder)) {
                  text = module.get.text();
                  module.verbose('Saving placeholder text as', text);
                  $module.data(metadata.placeholderText, text);
                }
              },
              remoteData: function(name, value) {
                if (window.Storage === undefined) {
                  module.error(error.noStorage);
                  return;
                }
                module.verbose('Saving remote data to session storage', value, name);
                sessionStorage.setItem(value, name);
              }
            },
            clear: function() {
              if (module.is.multiple()) {
                module.remove.labels();
              } else {
                module.remove.activeItem();
                module.remove.selectedItem();
              }
              module.set.placeholderText();
              module.clearValue();
            },
            clearValue: function() {
              module.set.value('');
            },
            scrollPage: function(direction, $selectedItem) {
              var $currentItem = $selectedItem || module.get.selectedItem(),
                  $menu = $currentItem.closest(selector.menu),
                  menuHeight = $menu.outerHeight(),
                  currentScroll = $menu.scrollTop(),
                  itemHeight = $item.eq(0).outerHeight(),
                  itemsPerPage = Math.floor(menuHeight / itemHeight),
                  maxScroll = $menu.prop('scrollHeight'),
                  newScroll = (direction == 'up') ? currentScroll - (itemHeight * itemsPerPage) : currentScroll + (itemHeight * itemsPerPage),
                  $selectableItem = $item.not(selector.unselectable),
                  isWithinRange,
                  $nextSelectedItem,
                  elementIndex;
              ;
              elementIndex = (direction == 'up') ? $selectableItem.index($currentItem) - itemsPerPage : $selectableItem.index($currentItem) + itemsPerPage;
              ;
              isWithinRange = (direction == 'up') ? (elementIndex >= 0) : (elementIndex < $selectableItem.length);
              ;
              $nextSelectedItem = (isWithinRange) ? $selectableItem.eq(elementIndex) : (direction == 'up') ? $selectableItem.first() : $selectableItem.last();
              ;
              if ($nextSelectedItem.length > 0) {
                module.debug('Scrolling page', direction, $nextSelectedItem);
                $currentItem.removeClass(className.selected);
                ;
                $nextSelectedItem.addClass(className.selected);
                ;
                $menu.scrollTop(newScroll);
                ;
              }
            },
            set: {
              filtered: function() {
                var isMultiple = module.is.multiple(),
                    isSearch = module.is.searchSelection(),
                    isSearchMultiple = (isMultiple && isSearch),
                    searchValue = (isSearch) ? module.get.query() : '',
                    hasSearchValue = (typeof searchValue === 'string' && searchValue.length > 0),
                    searchWidth = module.get.searchWidth(searchValue.length),
                    valueIsSet = searchValue !== '';
                ;
                if (isMultiple && hasSearchValue) {
                  module.verbose('Adjusting input width', searchWidth, settings.glyphWidth);
                  $search.css('width', searchWidth);
                }
                if (hasSearchValue || (isSearchMultiple && valueIsSet)) {
                  module.verbose('Hiding placeholder text');
                  $text.addClass(className.filtered);
                } else if (!isMultiple || (isSearchMultiple && !valueIsSet)) {
                  module.verbose('Showing placeholder text');
                  $text.removeClass(className.filtered);
                }
              },
              loading: function() {
                $module.addClass(className.loading);
              },
              placeholderText: function(text) {
                text = text || module.get.placeholderText();
                module.debug('Setting placeholder text', text);
                module.set.text(text);
                $text.addClass(className.placeholder);
              },
              tabbable: function() {
                if (module.has.search()) {
                  module.debug('Added tabindex to searchable dropdown');
                  $search.val('').attr('tabindex', 0);
                  ;
                  $menu.attr('tabindex', -1);
                  ;
                } else {
                  module.debug('Added tabindex to dropdown');
                  if (!$module.attr('tabindex')) {
                    $module.attr('tabindex', 0);
                    ;
                    $menu.attr('tabindex', -1);
                    ;
                  }
                }
              },
              initialLoad: function() {
                module.verbose('Setting initial load');
                initialLoad = true;
              },
              activeItem: function($item) {
                if (settings.allowAdditions && $item.filter(selector.addition).length > 0) {
                  $item.addClass(className.filtered);
                } else {
                  $item.addClass(className.active);
                }
              },
              scrollPosition: function($item, forceScroll) {
                var edgeTolerance = 5,
                    $menu,
                    hasActive,
                    offset,
                    itemHeight,
                    itemOffset,
                    menuOffset,
                    menuScroll,
                    menuHeight,
                    abovePage,
                    belowPage;
                ;
                $item = $item || module.get.selectedItem();
                $menu = $item.closest(selector.menu);
                hasActive = ($item && $item.length > 0);
                forceScroll = (forceScroll !== undefined) ? forceScroll : false;
                ;
                if ($item && $menu.length > 0 && hasActive) {
                  itemOffset = $item.position().top;
                  $menu.addClass(className.loading);
                  menuScroll = $menu.scrollTop();
                  menuOffset = $menu.offset().top;
                  itemOffset = $item.offset().top;
                  offset = menuScroll - menuOffset + itemOffset;
                  if (!forceScroll) {
                    menuHeight = $menu.height();
                    belowPage = menuScroll + menuHeight < (offset + edgeTolerance);
                    abovePage = ((offset - edgeTolerance) < menuScroll);
                  }
                  module.debug('Scrolling to active item', offset);
                  if (forceScroll || abovePage || belowPage) {
                    $menu.scrollTop(offset);
                  }
                  $menu.removeClass(className.loading);
                }
              },
              text: function(text) {
                if (settings.action !== 'select') {
                  if (settings.action == 'combo') {
                    module.debug('Changing combo button text', text, $combo);
                    if (settings.preserveHTML) {
                      $combo.html(text);
                    } else {
                      $combo.text(text);
                    }
                  } else {
                    if (text !== module.get.placeholderText()) {
                      $text.removeClass(className.placeholder);
                    }
                    module.debug('Changing text', text, $text);
                    $text.removeClass(className.filtered);
                    ;
                    if (settings.preserveHTML) {
                      $text.html(text);
                    } else {
                      $text.text(text);
                    }
                  }
                }
              },
              selectedLetter: function(letter) {
                var $selectedItem = $item.filter('.' + className.selected),
                    alreadySelectedLetter = $selectedItem.length > 0 && module.has.firstLetter($selectedItem, letter),
                    $nextValue = false,
                    $nextItem;
                ;
                if (alreadySelectedLetter) {
                  $nextItem = $selectedItem.nextAll($item).eq(0);
                  if (module.has.firstLetter($nextItem, letter)) {
                    $nextValue = $nextItem;
                  }
                }
                if (!$nextValue) {
                  $item.each(function() {
                    if (module.has.firstLetter($(this), letter)) {
                      $nextValue = $(this);
                      return false;
                    }
                  });
                  ;
                }
                if ($nextValue) {
                  module.verbose('Scrolling to next value with letter', letter);
                  module.set.scrollPosition($nextValue);
                  $selectedItem.removeClass(className.selected);
                  $nextValue.addClass(className.selected);
                }
              },
              direction: function($menu) {
                if (settings.direction == 'auto') {
                  if (module.is.onScreen($menu)) {
                    module.remove.upward($menu);
                  } else {
                    module.set.upward($menu);
                  }
                } else if (settings.direction == 'upward') {
                  module.set.upward($menu);
                }
              },
              upward: function($menu) {
                var $element = $menu || $module;
                $element.addClass(className.upward);
              },
              value: function(value, text, $selected) {
                var hasInput = ($input.length > 0),
                    isAddition = !module.has.value(value),
                    currentValue = module.get.values(),
                    stringValue = (value !== undefined) ? String(value) : value,
                    newValue;
                ;
                if (hasInput) {
                  if (stringValue == currentValue) {
                    module.verbose('Skipping value update already same value', value, currentValue);
                    if (!module.is.initialLoad()) {
                      return;
                    }
                  }
                  if (module.is.single() && module.has.selectInput() && module.can.extendSelect()) {
                    module.debug('Adding user option', value);
                    module.add.optionValue(value);
                  }
                  module.debug('Updating input value', value, currentValue);
                  internalChange = true;
                  $input.val(value);
                  ;
                  if (settings.fireOnInit === false && module.is.initialLoad()) {
                    module.debug('Input native change event ignored on initial load');
                  } else {
                    $input.trigger('change');
                  }
                  internalChange = false;
                } else {
                  module.verbose('Storing value in metadata', value, $input);
                  if (value !== currentValue) {
                    $module.data(metadata.value, stringValue);
                  }
                }
                if (settings.fireOnInit === false && module.is.initialLoad()) {
                  module.verbose('No callback on initial load', settings.onChange);
                } else {
                  settings.onChange.call(element, value, text, $selected);
                }
              },
              active: function() {
                $module.addClass(className.active);
                ;
              },
              multiple: function() {
                $module.addClass(className.multiple);
              },
              visible: function() {
                $module.addClass(className.visible);
              },
              exactly: function(value, $selectedItem) {
                module.debug('Setting selected to exact values');
                module.clear();
                module.set.selected(value, $selectedItem);
              },
              selected: function(value, $selectedItem) {
                var isMultiple = module.is.multiple(),
                    $userSelectedItem;
                ;
                $selectedItem = (settings.allowAdditions) ? $selectedItem || module.get.itemWithAdditions(value) : $selectedItem || module.get.item(value);
                ;
                if (!$selectedItem) {
                  return;
                }
                module.debug('Setting selected menu item to', $selectedItem);
                if (module.is.single()) {
                  module.remove.activeItem();
                  module.remove.selectedItem();
                } else if (settings.useLabels) {
                  module.remove.selectedItem();
                }
                $selectedItem.each(function() {
                  var $selected = $(this),
                      selectedText = module.get.choiceText($selected),
                      selectedValue = module.get.choiceValue($selected, selectedText),
                      isFiltered = $selected.hasClass(className.filtered),
                      isActive = $selected.hasClass(className.active),
                      isUserValue = $selected.hasClass(className.addition),
                      shouldAnimate = (isMultiple && $selectedItem.length == 1);
                  ;
                  if (isMultiple) {
                    if (!isActive || isUserValue) {
                      if (settings.apiSettings && settings.saveRemoteData) {
                        module.save.remoteData(selectedText, selectedValue);
                      }
                      if (settings.useLabels) {
                        module.add.value(selectedValue, selectedText, $selected);
                        module.add.label(selectedValue, selectedText, shouldAnimate);
                        module.set.activeItem($selected);
                        module.filterActive();
                        module.select.nextAvailable($selectedItem);
                      } else {
                        module.add.value(selectedValue, selectedText, $selected);
                        module.set.text(module.add.variables(message.count));
                        module.set.activeItem($selected);
                      }
                    } else if (!isFiltered) {
                      module.debug('Selected active value, removing label');
                      module.remove.selected(selectedValue);
                    }
                  } else {
                    if (settings.apiSettings && settings.saveRemoteData) {
                      module.save.remoteData(selectedText, selectedValue);
                    }
                    module.set.text(selectedText);
                    module.set.value(selectedValue, selectedText, $selected);
                    $selected.addClass(className.active).addClass(className.selected);
                    ;
                  }
                });
                ;
              }
            },
            add: {
              label: function(value, text, shouldAnimate) {
                var $next = module.is.searchSelection() ? $search : $text,
                    $label;
                ;
                $label = $('<a />').addClass(className.label).attr('data-value', value).html(templates.label(value, text));
                ;
                $label = settings.onLabelCreate.call($label, value, text);
                if (module.has.label(value)) {
                  module.debug('Label already exists, skipping', value);
                  return;
                }
                if (settings.label.variation) {
                  $label.addClass(settings.label.variation);
                }
                if (shouldAnimate === true) {
                  module.debug('Animating in label', $label);
                  $label.addClass(className.hidden).insertBefore($next).transition(settings.label.transition, settings.label.duration);
                  ;
                } else {
                  module.debug('Adding selection label', $label);
                  $label.insertBefore($next);
                  ;
                }
              },
              message: function(message) {
                var $message = $menu.children(selector.message),
                    html = settings.templates.message(module.add.variables(message));
                ;
                if ($message.length > 0) {
                  $message.html(html);
                  ;
                } else {
                  $message = $('<div/>').html(html).addClass(className.message).appendTo($menu);
                  ;
                }
              },
              optionValue: function(value) {
                var $option = $input.find('option[value="' + value + '"]'),
                    hasOption = ($option.length > 0);
                ;
                if (hasOption) {
                  return;
                }
                if (selectObserver) {
                  selectObserver.disconnect();
                  module.verbose('Temporarily disconnecting mutation observer', value);
                }
                if (module.is.single()) {
                  module.verbose('Removing previous user addition');
                  $input.find('option.' + className.addition).remove();
                }
                $('<option/>').prop('value', value).addClass(className.addition).html(value).appendTo($input);
                ;
                module.verbose('Adding user addition as an <option>', value);
                if (selectObserver) {
                  selectObserver.observe($input[0], {
                    childList: true,
                    subtree: true
                  });
                }
              },
              userSuggestion: function(value) {
                var $addition = $menu.children(selector.addition),
                    $existingItem = module.get.item(value),
                    alreadyHasValue = $existingItem && $existingItem.not(selector.addition).length,
                    hasUserSuggestion = $addition.length > 0,
                    html;
                ;
                if (settings.useLabels && module.has.maxSelections()) {
                  return;
                }
                if (value === '' || alreadyHasValue) {
                  $addition.remove();
                  return;
                }
                $item.removeClass(className.selected);
                ;
                if (hasUserSuggestion) {
                  html = settings.templates.addition(module.add.variables(message.addResult, value));
                  $addition.html(html).attr('data-' + metadata.value, value).attr('data-' + metadata.text, value).removeClass(className.filtered).addClass(className.selected);
                  ;
                  module.verbose('Replacing user suggestion with new value', $addition);
                } else {
                  $addition = module.create.userChoice(value);
                  $addition.prependTo($menu).addClass(className.selected);
                  ;
                  module.verbose('Adding item choice to menu corresponding with user choice addition', $addition);
                }
              },
              variables: function(message, term) {
                var hasCount = (message.search('{count}') !== -1),
                    hasMaxCount = (message.search('{maxCount}') !== -1),
                    hasTerm = (message.search('{term}') !== -1),
                    values,
                    count,
                    query;
                ;
                module.verbose('Adding templated variables to message', message);
                if (hasCount) {
                  count = module.get.selectionCount();
                  message = message.replace('{count}', count);
                }
                if (hasMaxCount) {
                  count = module.get.selectionCount();
                  message = message.replace('{maxCount}', settings.maxSelections);
                }
                if (hasTerm) {
                  query = term || module.get.query();
                  message = message.replace('{term}', query);
                }
                return message;
              },
              value: function(addedValue, addedText, $selectedItem) {
                var currentValue = module.get.values(),
                    newValue;
                ;
                if (addedValue === '') {
                  module.debug('Cannot select blank values from multiselect');
                  return;
                }
                if ($.isArray(currentValue)) {
                  newValue = currentValue.concat([addedValue]);
                  newValue = module.get.uniqueArray(newValue);
                } else {
                  newValue = [addedValue];
                }
                if (module.has.selectInput()) {
                  if (module.can.extendSelect()) {
                    module.debug('Adding value to select', addedValue, newValue, $input);
                    module.add.optionValue(addedValue);
                  }
                } else {
                  newValue = newValue.join(settings.delimiter);
                  module.debug('Setting hidden input to delimited value', newValue, $input);
                }
                if (settings.fireOnInit === false && module.is.initialLoad()) {
                  module.verbose('Skipping onadd callback on initial load', settings.onAdd);
                } else {
                  settings.onAdd.call(element, addedValue, addedText, $selectedItem);
                }
                module.set.value(newValue, addedValue, addedText, $selectedItem);
                module.check.maxSelections();
              }
            },
            remove: {
              active: function() {
                $module.removeClass(className.active);
              },
              activeLabel: function() {
                $module.find(selector.label).removeClass(className.active);
              },
              loading: function() {
                $module.removeClass(className.loading);
              },
              initialLoad: function() {
                initialLoad = false;
              },
              upward: function($menu) {
                var $element = $menu || $module;
                $element.removeClass(className.upward);
              },
              visible: function() {
                $module.removeClass(className.visible);
              },
              activeItem: function() {
                $item.removeClass(className.active);
              },
              filteredItem: function() {
                if (settings.useLabels && module.has.maxSelections()) {
                  return;
                }
                if (settings.useLabels && module.is.multiple()) {
                  $item.not('.' + className.active).removeClass(className.filtered);
                } else {
                  $item.removeClass(className.filtered);
                }
              },
              optionValue: function(value) {
                var $option = $input.find('option[value="' + value + '"]'),
                    hasOption = ($option.length > 0);
                ;
                if (!hasOption || !$option.hasClass(className.addition)) {
                  return;
                }
                if (selectObserver) {
                  selectObserver.disconnect();
                  module.verbose('Temporarily disconnecting mutation observer', value);
                }
                $option.remove();
                module.verbose('Removing user addition as an <option>', value);
                if (selectObserver) {
                  selectObserver.observe($input[0], {
                    childList: true,
                    subtree: true
                  });
                }
              },
              message: function() {
                $menu.children(selector.message).remove();
              },
              searchTerm: function() {
                module.verbose('Cleared search term');
                $search.val('');
                module.set.filtered();
              },
              selected: function(value, $selectedItem) {
                $selectedItem = (settings.allowAdditions) ? $selectedItem || module.get.itemWithAdditions(value) : $selectedItem || module.get.item(value);
                ;
                if (!$selectedItem) {
                  return false;
                }
                $selectedItem.each(function() {
                  var $selected = $(this),
                      selectedText = module.get.choiceText($selected),
                      selectedValue = module.get.choiceValue($selected, selectedText);
                  ;
                  if (module.is.multiple()) {
                    if (settings.useLabels) {
                      module.remove.value(selectedValue, selectedText, $selected);
                      module.remove.label(selectedValue);
                    } else {
                      module.remove.value(selectedValue, selectedText, $selected);
                      if (module.get.selectionCount() === 0) {
                        module.set.placeholderText();
                      } else {
                        module.set.text(module.add.variables(message.count));
                      }
                    }
                  } else {
                    module.remove.value(selectedValue, selectedText, $selected);
                  }
                  $selected.removeClass(className.filtered).removeClass(className.active);
                  ;
                  if (settings.useLabels) {
                    $selected.removeClass(className.selected);
                  }
                });
                ;
              },
              selectedItem: function() {
                $item.removeClass(className.selected);
              },
              value: function(removedValue, removedText, $removedItem) {
                var values = module.get.values(),
                    newValue;
                ;
                if (module.has.selectInput()) {
                  module.verbose('Input is <select> removing selected option', removedValue);
                  newValue = module.remove.arrayValue(removedValue, values);
                  module.remove.optionValue(removedValue);
                } else {
                  module.verbose('Removing from delimited values', removedValue);
                  newValue = module.remove.arrayValue(removedValue, values);
                  newValue = newValue.join(settings.delimiter);
                }
                if (settings.fireOnInit === false && module.is.initialLoad()) {
                  module.verbose('No callback on initial load', settings.onRemove);
                } else {
                  settings.onRemove.call(element, removedValue, removedText, $removedItem);
                }
                module.set.value(newValue, removedText, $removedItem);
                module.check.maxSelections();
              },
              arrayValue: function(removedValue, values) {
                if (!$.isArray(values)) {
                  values = [values];
                }
                values = $.grep(values, function(value) {
                  return (removedValue != value);
                });
                module.verbose('Removed value from delimited string', removedValue, values);
                return values;
              },
              label: function(value, shouldAnimate) {
                var $labels = $module.find(selector.label),
                    $removedLabel = $labels.filter('[data-value="' + value + '"]');
                ;
                module.verbose('Removing label', $removedLabel);
                $removedLabel.remove();
              },
              activeLabels: function($activeLabels) {
                $activeLabels = $activeLabels || $module.find(selector.label).filter('.' + className.active);
                module.verbose('Removing active label selections', $activeLabels);
                module.remove.labels($activeLabels);
              },
              labels: function($labels) {
                $labels = $labels || $module.find(selector.label);
                module.verbose('Removing labels', $labels);
                $labels.each(function() {
                  var value = $(this).data(metadata.value),
                      stringValue = (value !== undefined) ? String(value) : value,
                      isUserValue = module.is.userValue(stringValue);
                  ;
                  if (isUserValue) {
                    module.remove.value(stringValue);
                    module.remove.label(stringValue);
                  } else {
                    module.remove.selected(stringValue);
                  }
                });
                ;
              },
              tabbable: function() {
                if (module.has.search()) {
                  module.debug('Searchable dropdown initialized');
                  $search.attr('tabindex', '-1');
                  ;
                  $menu.attr('tabindex', '-1');
                  ;
                } else {
                  module.debug('Simple selection dropdown initialized');
                  $module.attr('tabindex', '-1');
                  ;
                  $menu.attr('tabindex', '-1');
                  ;
                }
              }
            },
            has: {
              search: function() {
                return ($search.length > 0);
              },
              selectInput: function() {
                return ($input.is('select'));
              },
              firstLetter: function($item, letter) {
                var text,
                    firstLetter;
                ;
                if (!$item || $item.length === 0 || typeof letter !== 'string') {
                  return false;
                }
                text = module.get.choiceText($item, false);
                letter = letter.toLowerCase();
                firstLetter = String(text).charAt(0).toLowerCase();
                return (letter == firstLetter);
              },
              input: function() {
                return ($input.length > 0);
              },
              items: function() {
                return ($item.length > 0);
              },
              menu: function() {
                return ($menu.length > 0);
              },
              message: function() {
                return ($menu.children(selector.message).length !== 0);
              },
              label: function(value) {
                var $labels = $module.find(selector.label);
                ;
                return ($labels.filter('[data-value="' + value + '"]').length > 0);
              },
              maxSelections: function() {
                return (settings.maxSelections && module.get.selectionCount() >= settings.maxSelections);
              },
              allResultsFiltered: function() {
                return ($item.filter(selector.unselectable).length === $item.length);
              },
              query: function() {
                return (module.get.query() !== '');
              },
              value: function(value) {
                var values = module.get.values(),
                    hasValue = $.isArray(values) ? values && ($.inArray(value, values) !== -1) : (values == value);
                ;
                return (hasValue) ? true : false;
                ;
              }
            },
            is: {
              active: function() {
                return $module.hasClass(className.active);
              },
              alreadySetup: function() {
                return ($module.is('select') && $module.parent(selector.dropdown).length > 0 && $module.prev().length === 0);
              },
              animating: function($subMenu) {
                return ($subMenu) ? $subMenu.transition && $subMenu.transition('is animating') : $menu.transition && $menu.transition('is animating');
                ;
              },
              disabled: function() {
                return $module.hasClass(className.disabled);
              },
              focused: function() {
                return (document.activeElement === $module[0]);
              },
              focusedOnSearch: function() {
                return (document.activeElement === $search[0]);
              },
              allFiltered: function() {
                return ((module.is.multiple() || module.has.search()) && !module.has.message() && module.has.allResultsFiltered());
              },
              hidden: function($subMenu) {
                return !module.is.visible($subMenu);
              },
              initialLoad: function() {
                return initialLoad;
              },
              onScreen: function($subMenu) {
                var $currentMenu = $subMenu || $menu,
                    canOpenDownward = true,
                    onScreen = {},
                    calculations;
                ;
                $currentMenu.addClass(className.loading);
                calculations = {
                  context: {
                    scrollTop: $context.scrollTop(),
                    height: $context.outerHeight()
                  },
                  menu: {
                    offset: $currentMenu.offset(),
                    height: $currentMenu.outerHeight()
                  }
                };
                onScreen = {
                  above: (calculations.context.scrollTop) <= calculations.menu.offset.top - calculations.menu.height,
                  below: (calculations.context.scrollTop + calculations.context.height) >= calculations.menu.offset.top + calculations.menu.height
                };
                if (onScreen.below) {
                  module.verbose('Dropdown can fit in context downward', onScreen);
                  canOpenDownward = true;
                } else if (!onScreen.below && !onScreen.above) {
                  module.verbose('Dropdown cannot fit in either direction, favoring downward', onScreen);
                  canOpenDownward = true;
                } else {
                  module.verbose('Dropdown cannot fit below, opening upward', onScreen);
                  canOpenDownward = false;
                }
                $currentMenu.removeClass(className.loading);
                return canOpenDownward;
              },
              inObject: function(needle, object) {
                var found = false;
                ;
                $.each(object, function(index, property) {
                  if (property == needle) {
                    found = true;
                    return true;
                  }
                });
                return found;
              },
              multiple: function() {
                return $module.hasClass(className.multiple);
              },
              single: function() {
                return !module.is.multiple();
              },
              selectMutation: function(mutations) {
                var selectChanged = false;
                ;
                $.each(mutations, function(index, mutation) {
                  if (mutation.target && $(mutation.target).is('select')) {
                    selectChanged = true;
                    return true;
                  }
                });
                return selectChanged;
              },
              search: function() {
                return $module.hasClass(className.search);
              },
              searchSelection: function() {
                return (module.has.search() && $search.parent(selector.dropdown).length === 1);
              },
              selection: function() {
                return $module.hasClass(className.selection);
              },
              userValue: function(value) {
                return ($.inArray(value, module.get.userValues()) !== -1);
              },
              upward: function($menu) {
                var $element = $menu || $module;
                return $element.hasClass(className.upward);
              },
              visible: function($subMenu) {
                return ($subMenu) ? $subMenu.hasClass(className.visible) : $menu.hasClass(className.visible);
                ;
              }
            },
            can: {
              activate: function($item) {
                if (settings.useLabels) {
                  return true;
                }
                if (!module.has.maxSelections()) {
                  return true;
                }
                if (module.has.maxSelections() && $item.hasClass(className.active)) {
                  return true;
                }
                return false;
              },
              click: function() {
                return (hasTouch || settings.on == 'click');
              },
              extendSelect: function() {
                return settings.allowAdditions || settings.apiSettings;
              },
              show: function() {
                return !module.is.disabled() && (module.has.items() || module.has.message());
              },
              useAPI: function() {
                return $.fn.api !== undefined;
              }
            },
            animate: {
              show: function(callback, $subMenu) {
                var $currentMenu = $subMenu || $menu,
                    start = ($subMenu) ? function() {} : function() {
                      module.hideSubMenus();
                      module.hideOthers();
                      module.set.active();
                    },
                    transition;
                ;
                callback = $.isFunction(callback) ? callback : function() {};
                ;
                module.verbose('Doing menu show animation', $currentMenu);
                module.set.direction($subMenu);
                transition = module.get.transition($subMenu);
                if (module.is.selection()) {
                  module.set.scrollPosition(module.get.selectedItem(), true);
                }
                if (module.is.hidden($currentMenu) || module.is.animating($currentMenu)) {
                  if (transition == 'none') {
                    start();
                    $currentMenu.transition('show');
                    callback.call(element);
                  } else if ($.fn.transition !== undefined && $module.transition('is supported')) {
                    $currentMenu.transition({
                      animation: transition + ' in',
                      debug: settings.debug,
                      verbose: settings.verbose,
                      duration: settings.duration,
                      queue: true,
                      onStart: start,
                      onComplete: function() {
                        callback.call(element);
                      }
                    });
                    ;
                  } else {
                    module.error(error.noTransition, transition);
                  }
                }
              },
              hide: function(callback, $subMenu) {
                var $currentMenu = $subMenu || $menu,
                    duration = ($subMenu) ? (settings.duration * 0.9) : settings.duration,
                    start = ($subMenu) ? function() {} : function() {
                      if (module.can.click()) {
                        module.unbind.intent();
                      }
                      module.remove.active();
                    },
                    transition = module.get.transition($subMenu);
                ;
                callback = $.isFunction(callback) ? callback : function() {};
                ;
                if (module.is.visible($currentMenu) || module.is.animating($currentMenu)) {
                  module.verbose('Doing menu hide animation', $currentMenu);
                  if (transition == 'none') {
                    start();
                    $currentMenu.transition('hide');
                    callback.call(element);
                  } else if ($.fn.transition !== undefined && $module.transition('is supported')) {
                    $currentMenu.transition({
                      animation: transition + ' out',
                      duration: settings.duration,
                      debug: settings.debug,
                      verbose: settings.verbose,
                      queue: true,
                      onStart: start,
                      onComplete: function() {
                        if (settings.direction == 'auto') {
                          module.remove.upward($subMenu);
                        }
                        callback.call(element);
                      }
                    });
                    ;
                  } else {
                    module.error(error.transition);
                  }
                }
              }
            },
            hideAndClear: function() {
              module.remove.searchTerm();
              if (module.has.maxSelections()) {
                return;
              }
              if (module.has.search()) {
                module.hide(function() {
                  module.remove.filteredItem();
                });
              } else {
                module.hide();
              }
            },
            delay: {
              show: function() {
                module.verbose('Delaying show event to ensure user intent');
                clearTimeout(module.timer);
                module.timer = setTimeout(module.show, settings.delay.show);
              },
              hide: function() {
                module.verbose('Delaying hide event to ensure user intent');
                clearTimeout(module.timer);
                module.timer = setTimeout(module.hide, settings.delay.hide);
              }
            },
            escape: {regExp: function(text) {
                text = String(text);
                return text.replace(regExp.escape, '\\$&');
              }},
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : $allModules;
        ;
      };
      $.fn.dropdown.settings = {
        debug: false,
        verbose: false,
        performance: true,
        on: 'click',
        action: 'activate',
        apiSettings: false,
        saveRemoteData: true,
        throttle: 200,
        context: window,
        direction: 'auto',
        keepOnScreen: true,
        match: 'both',
        fullTextSearch: false,
        placeholder: 'auto',
        preserveHTML: true,
        sortSelect: false,
        forceSelection: true,
        allowAdditions: false,
        maxSelections: false,
        useLabels: true,
        delimiter: ',',
        showOnFocus: true,
        allowTab: true,
        allowCategorySelection: false,
        fireOnInit: false,
        transition: 'auto',
        duration: 200,
        glyphWidth: 1.0714,
        label: {
          transition: 'scale',
          duration: 200,
          variation: false
        },
        delay: {
          hide: 300,
          show: 200,
          search: 20,
          touch: 50
        },
        onChange: function(value, text, $selected) {},
        onAdd: function(value, text, $selected) {},
        onRemove: function(value, text, $selected) {},
        onLabelSelect: function($selectedLabels) {},
        onLabelCreate: function(value, text) {
          return $(this);
        },
        onNoResults: function(searchTerm) {
          return true;
        },
        onShow: function() {},
        onHide: function() {},
        name: 'Dropdown',
        namespace: 'dropdown',
        message: {
          addResult: 'Add <b>{term}</b>',
          count: '{count} selected',
          maxSelections: 'Max {maxCount} selections',
          noResults: 'No results found.',
          serverError: 'There was an error contacting the server'
        },
        error: {
          action: 'You called a dropdown action that was not defined',
          alreadySetup: 'Once a select has been initialized behaviors must be called on the created ui dropdown',
          labels: 'Allowing user additions currently requires the use of labels.',
          missingMultiple: '<select> requires multiple property to be set to correctly preserve multiple values',
          method: 'The method you called is not defined.',
          noAPI: 'The API module is required to load resources remotely',
          noStorage: 'Saving remote data requires session storage',
          noTransition: 'This module requires ui transitions <https://github.com/Semantic-Org/UI-Transition>'
        },
        regExp: {escape: /[-[\]{}()*+?.,\\^$|#\s]/g},
        metadata: {
          defaultText: 'defaultText',
          defaultValue: 'defaultValue',
          placeholderText: 'placeholder',
          text: 'text',
          value: 'value'
        },
        fields: {
          values: 'values',
          name: 'name',
          value: 'value'
        },
        selector: {
          addition: '.addition',
          dropdown: '.ui.dropdown',
          icon: '> .dropdown.icon',
          input: '> input[type="hidden"], > select',
          item: '.item',
          label: '> .label',
          remove: '> .label > .delete.icon',
          siblingLabel: '.label',
          menu: '.menu',
          message: '.message',
          menuIcon: '.dropdown.icon',
          search: 'input.search, .menu > .search > input',
          text: '> .text:not(.icon)',
          unselectable: '.disabled, .filtered'
        },
        className: {
          active: 'active',
          addition: 'addition',
          animating: 'animating',
          disabled: 'disabled',
          dropdown: 'ui dropdown',
          filtered: 'filtered',
          hidden: 'hidden transition',
          item: 'item',
          label: 'ui label',
          loading: 'loading',
          menu: 'menu',
          message: 'message',
          multiple: 'multiple',
          placeholder: 'default',
          search: 'search',
          selected: 'selected',
          selection: 'selection',
          upward: 'upward',
          visible: 'visible'
        }
      };
      $.fn.dropdown.settings.templates = {
        dropdown: function(select) {
          var placeholder = select.placeholder || false,
              values = select.values || {},
              html = '';
          ;
          html += '<i class="dropdown icon"></i>';
          if (select.placeholder) {
            html += '<div class="default text">' + placeholder + '</div>';
          } else {
            html += '<div class="text"></div>';
          }
          html += '<div class="menu">';
          $.each(select.values, function(index, option) {
            html += (option.disabled) ? '<div class="disabled item" data-value="' + option.value + '">' + option.name + '</div>' : '<div class="item" data-value="' + option.value + '">' + option.name + '</div>';
            ;
          });
          html += '</div>';
          return html;
        },
        menu: function(response, fields) {
          var values = response.values || {},
              html = '';
          ;
          $.each(response[fields.values], function(index, option) {
            html += '<div class="item" data-value="' + option[fields.value] + '">' + option[fields.name] + '</div>';
          });
          return html;
        },
        label: function(value, text) {
          return text + '<i class="delete icon"></i>';
        },
        message: function(message) {
          return message;
        },
        addition: function(choice) {
          return choice;
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.embed = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.embed.settings, parameters) : $.extend({}, $.fn.embed.settings),
              selector = settings.selector,
              className = settings.className,
              sources = settings.sources,
              error = settings.error,
              metadata = settings.metadata,
              namespace = settings.namespace,
              templates = settings.templates,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $window = $(window),
              $module = $(this),
              $placeholder = $module.find(selector.placeholder),
              $icon = $module.find(selector.icon),
              $embed = $module.find(selector.embed),
              element = this,
              instance = $module.data(moduleNamespace),
              module;
          ;
          module = {
            initialize: function() {
              module.debug('Initializing embed');
              module.determine.autoplay();
              module.create();
              module.bind.events();
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous instance of embed');
              module.reset();
              $module.removeData(moduleNamespace).off(eventNamespace);
              ;
            },
            refresh: function() {
              module.verbose('Refreshing selector cache');
              $placeholder = $module.find(selector.placeholder);
              $icon = $module.find(selector.icon);
              $embed = $module.find(selector.embed);
            },
            bind: {events: function() {
                if (module.has.placeholder()) {
                  module.debug('Adding placeholder events');
                  $module.on('click' + eventNamespace, selector.placeholder, module.createAndShow).on('click' + eventNamespace, selector.icon, module.createAndShow);
                  ;
                }
              }},
            create: function() {
              var placeholder = module.get.placeholder();
              ;
              if (placeholder) {
                module.createPlaceholder();
              } else {
                module.createAndShow();
              }
            },
            createPlaceholder: function(placeholder) {
              var icon = module.get.icon(),
                  url = module.get.url(),
                  embed = module.generate.embed(url);
              ;
              placeholder = placeholder || module.get.placeholder();
              $module.html(templates.placeholder(placeholder, icon));
              module.debug('Creating placeholder for embed', placeholder, icon);
            },
            createEmbed: function(url) {
              module.refresh();
              url = url || module.get.url();
              $embed = $('<div/>').addClass(className.embed).html(module.generate.embed(url)).appendTo($module);
              ;
              settings.onCreate.call(element, url);
              module.debug('Creating embed object', $embed);
            },
            createAndShow: function() {
              module.createEmbed();
              module.show();
            },
            change: function(source, id, url) {
              module.debug('Changing video to ', source, id, url);
              $module.data(metadata.source, source).data(metadata.id, id).data(metadata.url, url);
              ;
              module.create();
            },
            reset: function() {
              module.debug('Clearing embed and showing placeholder');
              module.remove.active();
              module.remove.embed();
              module.showPlaceholder();
              settings.onReset.call(element);
            },
            show: function() {
              module.debug('Showing embed');
              module.set.active();
              settings.onDisplay.call(element);
            },
            hide: function() {
              module.debug('Hiding embed');
              module.showPlaceholder();
            },
            showPlaceholder: function() {
              module.debug('Showing placeholder image');
              module.remove.active();
              settings.onPlaceholderDisplay.call(element);
            },
            get: {
              id: function() {
                return settings.id || $module.data(metadata.id);
              },
              placeholder: function() {
                return settings.placeholder || $module.data(metadata.placeholder);
              },
              icon: function() {
                return (settings.icon) ? settings.icon : ($module.data(metadata.icon) !== undefined) ? $module.data(metadata.icon) : module.determine.icon();
                ;
              },
              source: function(url) {
                return (settings.source) ? settings.source : ($module.data(metadata.source) !== undefined) ? $module.data(metadata.source) : module.determine.source();
                ;
              },
              type: function() {
                var source = module.get.source();
                return (sources[source] !== undefined) ? sources[source].type : false;
                ;
              },
              url: function() {
                return (settings.url) ? settings.url : ($module.data(metadata.url) !== undefined) ? $module.data(metadata.url) : module.determine.url();
                ;
              }
            },
            determine: {
              autoplay: function() {
                if (module.should.autoplay()) {
                  settings.autoplay = true;
                }
              },
              source: function(url) {
                var matchedSource = false;
                ;
                url = url || module.get.url();
                if (url) {
                  $.each(sources, function(name, source) {
                    if (url.search(source.domain) !== -1) {
                      matchedSource = name;
                      return false;
                    }
                  });
                }
                return matchedSource;
              },
              icon: function() {
                var source = module.get.source();
                ;
                return (sources[source] !== undefined) ? sources[source].icon : false;
                ;
              },
              url: function() {
                var id = settings.id || $module.data(metadata.id),
                    source = settings.source || $module.data(metadata.source),
                    url;
                ;
                url = (sources[source] !== undefined) ? sources[source].url.replace('{id}', id) : false;
                ;
                if (url) {
                  $module.data(metadata.url, url);
                }
                return url;
              }
            },
            set: {active: function() {
                $module.addClass(className.active);
              }},
            remove: {
              active: function() {
                $module.removeClass(className.active);
              },
              embed: function() {
                $embed.empty();
              }
            },
            encode: {parameters: function(parameters) {
                var urlString = [],
                    index;
                ;
                for (index in parameters) {
                  urlString.push(encodeURIComponent(index) + '=' + encodeURIComponent(parameters[index]));
                }
                return urlString.join('&amp;');
              }},
            generate: {
              embed: function(url) {
                module.debug('Generating embed html');
                var source = module.get.source(),
                    html,
                    parameters;
                ;
                url = module.get.url(url);
                if (url) {
                  parameters = module.generate.parameters(source);
                  html = templates.iframe(url, parameters);
                } else {
                  module.error(error.noURL, $module);
                }
                return html;
              },
              parameters: function(source, extraParameters) {
                var parameters = (sources[source] && sources[source].parameters !== undefined) ? sources[source].parameters(settings) : {};
                ;
                extraParameters = extraParameters || settings.parameters;
                if (extraParameters) {
                  parameters = $.extend({}, parameters, extraParameters);
                }
                parameters = settings.onEmbed(parameters);
                return module.encode.parameters(parameters);
              }
            },
            has: {placeholder: function() {
                return settings.placeholder || $module.data(metadata.placeholder);
              }},
            should: {autoplay: function() {
                return (settings.autoplay === 'auto') ? (settings.placeholder || $module.data(metadata.placeholder) !== undefined) : settings.autoplay;
                ;
              }},
            is: {video: function() {
                return module.get.type() == 'video';
              }},
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ($allModules.length > 1) {
                  title += ' ' + '(' + $allModules.length + ')';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.embed.settings = {
        name: 'Embed',
        namespace: 'embed',
        debug: false,
        verbose: false,
        performance: true,
        icon: false,
        source: false,
        url: false,
        id: false,
        autoplay: 'auto',
        color: '#444444',
        hd: true,
        brandedUI: false,
        parameters: false,
        onDisplay: function() {},
        onPlaceholderDisplay: function() {},
        onReset: function() {},
        onCreate: function(url) {},
        onEmbed: function(parameters) {
          return parameters;
        },
        metadata: {
          id: 'id',
          icon: 'icon',
          placeholder: 'placeholder',
          source: 'source',
          url: 'url'
        },
        error: {
          noURL: 'No URL specified',
          method: 'The method you called is not defined'
        },
        className: {
          active: 'active',
          embed: 'embed'
        },
        selector: {
          embed: '.embed',
          placeholder: '.placeholder',
          icon: '.icon'
        },
        sources: {
          youtube: {
            name: 'youtube',
            type: 'video',
            icon: 'video play',
            domain: 'youtube.com',
            url: '//www.youtube.com/embed/{id}',
            parameters: function(settings) {
              return {
                autohide: !settings.brandedUI,
                autoplay: settings.autoplay,
                color: settings.colors || undefined,
                hq: settings.hd,
                jsapi: settings.api,
                modestbranding: !settings.brandedUI
              };
            }
          },
          vimeo: {
            name: 'vimeo',
            type: 'video',
            icon: 'video play',
            domain: 'vimeo.com',
            url: '//player.vimeo.com/video/{id}',
            parameters: function(settings) {
              return {
                api: settings.api,
                autoplay: settings.autoplay,
                byline: settings.brandedUI,
                color: settings.colors || undefined,
                portrait: settings.brandedUI,
                title: settings.brandedUI
              };
            }
          }
        },
        templates: {
          iframe: function(url, parameters) {
            return '' + '<iframe src="' + url + '?' + parameters + '"' + ' width="100%" height="100%"' + ' frameborder="0" scrolling="no" webkitAllowFullScreen mozallowfullscreen allowFullScreen></iframe>';
            ;
          },
          placeholder: function(image, icon) {
            var html = '';
            ;
            if (icon) {
              html += '<i class="' + icon + ' icon"></i>';
            }
            if (image) {
              html += '<img class="placeholder" src="' + image + '">';
            }
            return html;
          }
        },
        api: true,
        onPause: function() {},
        onPlay: function() {},
        onStop: function() {}
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.modal = function(parameters) {
        var $allModules = $(this),
            $window = $(window),
            $document = $(document),
            $body = $('body'),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
              setTimeout(callback, 0);
            },
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.modal.settings, parameters) : $.extend({}, $.fn.modal.settings),
              selector = settings.selector,
              className = settings.className,
              namespace = settings.namespace,
              error = settings.error,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $module = $(this),
              $context = $(settings.context),
              $close = $module.find(selector.close),
              $allModals,
              $otherModals,
              $focusedElement,
              $dimmable,
              $dimmer,
              element = this,
              instance = $module.data(moduleNamespace),
              elementNamespace,
              id,
              observer,
              module;
          ;
          module = {
            initialize: function() {
              module.verbose('Initializing dimmer', $context);
              module.create.id();
              module.create.dimmer();
              module.refreshModals();
              module.bind.events();
              if (settings.observeChanges) {
                module.observeChanges();
              }
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of modal');
              instance = module;
              $module.data(moduleNamespace, instance);
              ;
            },
            create: {
              dimmer: function() {
                var defaultSettings = {
                  debug: settings.debug,
                  dimmerName: 'modals',
                  duration: {
                    show: settings.duration,
                    hide: settings.duration
                  }
                },
                    dimmerSettings = $.extend(true, defaultSettings, settings.dimmerSettings);
                ;
                if (settings.inverted) {
                  dimmerSettings.variation = (dimmerSettings.variation !== undefined) ? dimmerSettings.variation + ' inverted' : 'inverted';
                  ;
                }
                if ($.fn.dimmer === undefined) {
                  module.error(error.dimmer);
                  return;
                }
                module.debug('Creating dimmer with settings', dimmerSettings);
                $dimmable = $context.dimmer(dimmerSettings);
                if (settings.detachable) {
                  module.verbose('Modal is detachable, moving content into dimmer');
                  $dimmable.dimmer('add content', $module);
                } else {
                  module.set.undetached();
                }
                if (settings.blurring) {
                  $dimmable.addClass(className.blurring);
                }
                $dimmer = $dimmable.dimmer('get dimmer');
              },
              id: function() {
                id = (Math.random().toString(16) + '000000000').substr(2, 8);
                elementNamespace = '.' + id;
                module.verbose('Creating unique id for element', id);
              }
            },
            destroy: function() {
              module.verbose('Destroying previous modal');
              $module.removeData(moduleNamespace).off(eventNamespace);
              ;
              $window.off(elementNamespace);
              $close.off(eventNamespace);
              $context.dimmer('destroy');
            },
            observeChanges: function() {
              if ('MutationObserver' in window) {
                observer = new MutationObserver(function(mutations) {
                  module.debug('DOM tree modified, refreshing');
                  module.refresh();
                });
                observer.observe(element, {
                  childList: true,
                  subtree: true
                });
                module.debug('Setting up mutation observer', observer);
              }
            },
            refresh: function() {
              module.remove.scrolling();
              module.cacheSizes();
              module.set.screenHeight();
              module.set.type();
              module.set.position();
            },
            refreshModals: function() {
              $otherModals = $module.siblings(selector.modal);
              $allModals = $otherModals.add($module);
            },
            attachEvents: function(selector, event) {
              var $toggle = $(selector);
              ;
              event = $.isFunction(module[event]) ? module[event] : module.toggle;
              ;
              if ($toggle.length > 0) {
                module.debug('Attaching modal events to element', selector, event);
                $toggle.off(eventNamespace).on('click' + eventNamespace, event);
                ;
              } else {
                module.error(error.notFound, selector);
              }
            },
            bind: {events: function() {
                module.verbose('Attaching events');
                $module.on('click' + eventNamespace, selector.close, module.event.close).on('click' + eventNamespace, selector.approve, module.event.approve).on('click' + eventNamespace, selector.deny, module.event.deny);
                ;
                $window.on('resize' + elementNamespace, module.event.resize);
                ;
              }},
            get: {id: function() {
                return (Math.random().toString(16) + '000000000').substr(2, 8);
              }},
            event: {
              approve: function() {
                if (settings.onApprove.call(element, $(this)) === false) {
                  module.verbose('Approve callback returned false cancelling hide');
                  return;
                }
                module.hide();
              },
              deny: function() {
                if (settings.onDeny.call(element, $(this)) === false) {
                  module.verbose('Deny callback returned false cancelling hide');
                  return;
                }
                module.hide();
              },
              close: function() {
                module.hide();
              },
              click: function(event) {
                var $target = $(event.target),
                    isInModal = ($target.closest(selector.modal).length > 0),
                    isInDOM = $.contains(document.documentElement, event.target);
                ;
                if (!isInModal && isInDOM) {
                  module.debug('Dimmer clicked, hiding all modals');
                  if (module.is.active()) {
                    module.remove.clickaway();
                    if (settings.allowMultiple) {
                      module.hide();
                    } else {
                      module.hideAll();
                    }
                  }
                }
              },
              debounce: function(method, delay) {
                clearTimeout(module.timer);
                module.timer = setTimeout(method, delay);
              },
              keyboard: function(event) {
                var keyCode = event.which,
                    escapeKey = 27;
                ;
                if (keyCode == escapeKey) {
                  if (settings.closable) {
                    module.debug('Escape key pressed hiding modal');
                    module.hide();
                  } else {
                    module.debug('Escape key pressed, but closable is set to false');
                  }
                  event.preventDefault();
                }
              },
              resize: function() {
                if ($dimmable.dimmer('is active')) {
                  requestAnimationFrame(module.refresh);
                }
              }
            },
            toggle: function() {
              if (module.is.active() || module.is.animating()) {
                module.hide();
              } else {
                module.show();
              }
            },
            show: function(callback) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              module.refreshModals();
              module.showModal(callback);
            },
            hide: function(callback) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              module.refreshModals();
              module.hideModal(callback);
            },
            showModal: function(callback) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              if (module.is.animating() || !module.is.active()) {
                module.showDimmer();
                module.cacheSizes();
                module.set.position();
                module.set.screenHeight();
                module.set.type();
                module.set.clickaway();
                if (!settings.allowMultiple && module.others.active()) {
                  module.hideOthers(module.showModal);
                } else {
                  settings.onShow.call(element);
                  if (settings.transition && $.fn.transition !== undefined && $module.transition('is supported')) {
                    module.debug('Showing modal with css animations');
                    $module.transition({
                      debug: settings.debug,
                      animation: settings.transition + ' in',
                      queue: settings.queue,
                      duration: settings.duration,
                      useFailSafe: true,
                      onComplete: function() {
                        settings.onVisible.apply(element);
                        module.add.keyboardShortcuts();
                        module.save.focus();
                        module.set.active();
                        if (settings.autofocus) {
                          module.set.autofocus();
                        }
                        callback();
                      }
                    });
                    ;
                  } else {
                    module.error(error.noTransition);
                  }
                }
              } else {
                module.debug('Modal is already visible');
              }
            },
            hideModal: function(callback, keepDimmed) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              module.debug('Hiding modal');
              settings.onHide.call(element);
              if (module.is.animating() || module.is.active()) {
                if (settings.transition && $.fn.transition !== undefined && $module.transition('is supported')) {
                  module.remove.active();
                  $module.transition({
                    debug: settings.debug,
                    animation: settings.transition + ' out',
                    queue: settings.queue,
                    duration: settings.duration,
                    useFailSafe: true,
                    onStart: function() {
                      if (!module.others.active() && !keepDimmed) {
                        module.hideDimmer();
                      }
                      module.remove.keyboardShortcuts();
                    },
                    onComplete: function() {
                      settings.onHidden.call(element);
                      module.restore.focus();
                      callback();
                    }
                  });
                  ;
                } else {
                  module.error(error.noTransition);
                }
              }
            },
            showDimmer: function() {
              if ($dimmable.dimmer('is animating') || !$dimmable.dimmer('is active')) {
                module.debug('Showing dimmer');
                $dimmable.dimmer('show');
              } else {
                module.debug('Dimmer already visible');
              }
            },
            hideDimmer: function() {
              if ($dimmable.dimmer('is animating') || ($dimmable.dimmer('is active'))) {
                $dimmable.dimmer('hide', function() {
                  module.remove.clickaway();
                  module.remove.screenHeight();
                });
              } else {
                module.debug('Dimmer is not visible cannot hide');
                return;
              }
            },
            hideAll: function(callback) {
              var $visibleModals = $allModals.filter('.' + className.active + ', .' + className.animating);
              ;
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              if ($visibleModals.length > 0) {
                module.debug('Hiding all visible modals');
                module.hideDimmer();
                $visibleModals.modal('hide modal', callback);
                ;
              }
            },
            hideOthers: function(callback) {
              var $visibleModals = $otherModals.filter('.' + className.active + ', .' + className.animating);
              ;
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              if ($visibleModals.length > 0) {
                module.debug('Hiding other modals', $otherModals);
                $visibleModals.modal('hide modal', callback, true);
                ;
              }
            },
            others: {
              active: function() {
                return ($otherModals.filter('.' + className.active).length > 0);
              },
              animating: function() {
                return ($otherModals.filter('.' + className.animating).length > 0);
              }
            },
            add: {keyboardShortcuts: function() {
                module.verbose('Adding keyboard shortcuts');
                $document.on('keyup' + eventNamespace, module.event.keyboard);
                ;
              }},
            save: {focus: function() {
                $focusedElement = $(document.activeElement).blur();
              }},
            restore: {focus: function() {
                if ($focusedElement && $focusedElement.length > 0) {
                  $focusedElement.focus();
                }
              }},
            remove: {
              active: function() {
                $module.removeClass(className.active);
              },
              clickaway: function() {
                if (settings.closable) {
                  $dimmer.off('click' + elementNamespace);
                  ;
                }
              },
              bodyStyle: function() {
                if ($body.attr('style') === '') {
                  module.verbose('Removing style attribute');
                  $body.removeAttr('style');
                }
              },
              screenHeight: function() {
                module.debug('Removing page height');
                $body.css('height', '');
                ;
              },
              keyboardShortcuts: function() {
                module.verbose('Removing keyboard shortcuts');
                $document.off('keyup' + eventNamespace);
                ;
              },
              scrolling: function() {
                $dimmable.removeClass(className.scrolling);
                $module.removeClass(className.scrolling);
              }
            },
            cacheSizes: function() {
              var modalHeight = $module.outerHeight();
              ;
              if (module.cache === undefined || modalHeight !== 0) {
                module.cache = {
                  pageHeight: $(document).outerHeight(),
                  height: modalHeight + settings.offset,
                  contextHeight: (settings.context == 'body') ? $(window).height() : $dimmable.height()
                };
              }
              module.debug('Caching modal and container sizes', module.cache);
            },
            can: {fit: function() {
                return ((module.cache.height + (settings.padding * 2)) < module.cache.contextHeight);
              }},
            is: {
              active: function() {
                return $module.hasClass(className.active);
              },
              animating: function() {
                return $module.transition('is supported') ? $module.transition('is animating') : $module.is(':visible');
                ;
              },
              scrolling: function() {
                return $dimmable.hasClass(className.scrolling);
              },
              modernBrowser: function() {
                return !(window.ActiveXObject || "ActiveXObject" in window);
              }
            },
            set: {
              autofocus: function() {
                var $inputs = $module.find(':input').filter(':visible'),
                    $autofocus = $inputs.filter('[autofocus]'),
                    $input = ($autofocus.length > 0) ? $autofocus.first() : $inputs.first();
                ;
                if ($input.length > 0) {
                  $input.focus();
                }
              },
              clickaway: function() {
                if (settings.closable) {
                  $dimmer.on('click' + elementNamespace, module.event.click);
                  ;
                }
              },
              screenHeight: function() {
                if (module.can.fit()) {
                  $body.css('height', '');
                } else {
                  module.debug('Modal is taller than page content, resizing page height');
                  $body.css('height', module.cache.height + (settings.padding * 2));
                  ;
                }
              },
              active: function() {
                $module.addClass(className.active);
              },
              scrolling: function() {
                $dimmable.addClass(className.scrolling);
                $module.addClass(className.scrolling);
              },
              type: function() {
                if (module.can.fit()) {
                  module.verbose('Modal fits on screen');
                  if (!module.others.active() && !module.others.animating()) {
                    module.remove.scrolling();
                  }
                } else {
                  module.verbose('Modal cannot fit on screen setting to scrolling');
                  module.set.scrolling();
                }
              },
              position: function() {
                module.verbose('Centering modal on page', module.cache);
                if (module.can.fit()) {
                  $module.css({
                    top: '',
                    marginTop: -(module.cache.height / 2)
                  });
                  ;
                } else {
                  $module.css({
                    marginTop: '',
                    top: $document.scrollTop()
                  });
                  ;
                }
              },
              undetached: function() {
                $dimmable.addClass(className.undetached);
              }
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.modal.settings = {
        name: 'Modal',
        namespace: 'modal',
        debug: false,
        verbose: false,
        performance: true,
        observeChanges: false,
        allowMultiple: false,
        detachable: true,
        closable: true,
        autofocus: true,
        inverted: false,
        blurring: false,
        dimmerSettings: {
          closable: false,
          useCSS: true
        },
        context: 'body',
        queue: false,
        duration: 500,
        offset: 0,
        transition: 'scale',
        padding: 50,
        onShow: function() {},
        onVisible: function() {},
        onHide: function() {},
        onHidden: function() {},
        onApprove: function() {
          return true;
        },
        onDeny: function() {
          return true;
        },
        selector: {
          close: '> .close',
          approve: '.actions .positive, .actions .approve, .actions .ok',
          deny: '.actions .negative, .actions .deny, .actions .cancel',
          modal: '.ui.modal'
        },
        error: {
          dimmer: 'UI Dimmer, a required component is not included in this page',
          method: 'The method you called is not defined.',
          notFound: 'The element you specified could not be found'
        },
        className: {
          active: 'active',
          animating: 'animating',
          blurring: 'blurring',
          scrolling: 'scrolling',
          undetached: 'undetached'
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.nag = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.nag.settings, parameters) : $.extend({}, $.fn.nag.settings),
              className = settings.className,
              selector = settings.selector,
              error = settings.error,
              namespace = settings.namespace,
              eventNamespace = '.' + namespace,
              moduleNamespace = namespace + '-module',
              $module = $(this),
              $close = $module.find(selector.close),
              $context = (settings.context) ? $(settings.context) : $('body'),
              element = this,
              instance = $module.data(moduleNamespace),
              moduleOffset,
              moduleHeight,
              contextWidth,
              contextHeight,
              contextOffset,
              yOffset,
              yPosition,
              timer,
              module,
              requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
                setTimeout(callback, 0);
              };
          ;
          module = {
            initialize: function() {
              module.verbose('Initializing element');
              $module.on('click' + eventNamespace, selector.close, module.dismiss).data(moduleNamespace, module);
              ;
              if (settings.detachable && $module.parent()[0] !== $context[0]) {
                $module.detach().prependTo($context);
                ;
              }
              if (settings.displayTime > 0) {
                setTimeout(module.hide, settings.displayTime);
              }
              module.show();
            },
            destroy: function() {
              module.verbose('Destroying instance');
              $module.removeData(moduleNamespace).off(eventNamespace);
              ;
            },
            show: function() {
              if (module.should.show() && !$module.is(':visible')) {
                module.debug('Showing nag', settings.animation.show);
                if (settings.animation.show == 'fade') {
                  $module.fadeIn(settings.duration, settings.easing);
                  ;
                } else {
                  $module.slideDown(settings.duration, settings.easing);
                  ;
                }
              }
            },
            hide: function() {
              module.debug('Showing nag', settings.animation.hide);
              if (settings.animation.show == 'fade') {
                $module.fadeIn(settings.duration, settings.easing);
                ;
              } else {
                $module.slideUp(settings.duration, settings.easing);
                ;
              }
            },
            onHide: function() {
              module.debug('Removing nag', settings.animation.hide);
              $module.remove();
              if (settings.onHide) {
                settings.onHide();
              }
            },
            dismiss: function(event) {
              if (settings.storageMethod) {
                module.storage.set(settings.key, settings.value);
              }
              module.hide();
              event.stopImmediatePropagation();
              event.preventDefault();
            },
            should: {show: function() {
                if (settings.persist) {
                  module.debug('Persistent nag is set, can show nag');
                  return true;
                }
                if (module.storage.get(settings.key) != settings.value.toString()) {
                  module.debug('Stored value is not set, can show nag', module.storage.get(settings.key));
                  return true;
                }
                module.debug('Stored value is set, cannot show nag', module.storage.get(settings.key));
                return false;
              }},
            get: {storageOptions: function() {
                var options = {};
                ;
                if (settings.expires) {
                  options.expires = settings.expires;
                }
                if (settings.domain) {
                  options.domain = settings.domain;
                }
                if (settings.path) {
                  options.path = settings.path;
                }
                return options;
              }},
            clear: function() {
              module.storage.remove(settings.key);
            },
            storage: {
              set: function(key, value) {
                var options = module.get.storageOptions();
                ;
                if (settings.storageMethod == 'localstorage' && window.localStorage !== undefined) {
                  window.localStorage.setItem(key, value);
                  module.debug('Value stored using local storage', key, value);
                } else if (settings.storageMethod == 'sessionstorage' && window.sessionStorage !== undefined) {
                  window.sessionStorage.setItem(key, value);
                  module.debug('Value stored using session storage', key, value);
                } else if ($.cookie !== undefined) {
                  $.cookie(key, value, options);
                  module.debug('Value stored using cookie', key, value, options);
                } else {
                  module.error(error.noCookieStorage);
                  return;
                }
              },
              get: function(key, value) {
                var storedValue;
                ;
                if (settings.storageMethod == 'localstorage' && window.localStorage !== undefined) {
                  storedValue = window.localStorage.getItem(key);
                } else if (settings.storageMethod == 'sessionstorage' && window.sessionStorage !== undefined) {
                  storedValue = window.sessionStorage.getItem(key);
                } else if ($.cookie !== undefined) {
                  storedValue = $.cookie(key);
                } else {
                  module.error(error.noCookieStorage);
                }
                if (storedValue == 'undefined' || storedValue == 'null' || storedValue === undefined || storedValue === null) {
                  storedValue = undefined;
                }
                return storedValue;
              },
              remove: function(key) {
                var options = module.get.storageOptions();
                ;
                if (settings.storageMethod == 'localstorage' && window.localStorage !== undefined) {
                  window.localStorage.removeItem(key);
                } else if (settings.storageMethod == 'sessionstorage' && window.sessionStorage !== undefined) {
                  window.sessionStorage.removeItem(key);
                } else if ($.cookie !== undefined) {
                  $.removeCookie(key, options);
                } else {
                  module.error(error.noStorage);
                }
              }
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.nag.settings = {
        name: 'Nag',
        debug: false,
        verbose: false,
        performance: true,
        namespace: 'Nag',
        persist: false,
        displayTime: 0,
        animation: {
          show: 'slide',
          hide: 'slide'
        },
        context: false,
        detachable: false,
        expires: 30,
        domain: false,
        path: '/',
        storageMethod: 'cookie',
        key: 'nag',
        value: 'dismiss',
        error: {
          noCookieStorage: '$.cookie is not included. A storage solution is required.',
          noStorage: 'Neither $.cookie or store is defined. A storage solution is required for storing state',
          method: 'The method you called is not defined.'
        },
        className: {
          bottom: 'bottom',
          fixed: 'fixed'
        },
        selector: {close: '.close.icon'},
        speed: 500,
        easing: 'easeOutQuad',
        onHide: function() {}
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.popup = function(parameters) {
        var $allModules = $(this),
            $document = $(document),
            $window = $(window),
            $body = $('body'),
            moduleSelector = $allModules.selector || '',
            hasTouch = (true),
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.popup.settings, parameters) : $.extend({}, $.fn.popup.settings),
              selector = settings.selector,
              className = settings.className,
              error = settings.error,
              metadata = settings.metadata,
              namespace = settings.namespace,
              eventNamespace = '.' + settings.namespace,
              moduleNamespace = 'module-' + namespace,
              $module = $(this),
              $context = $(settings.context),
              $target = (settings.target) ? $(settings.target) : $module,
              $popup,
              $offsetParent,
              searchDepth = 0,
              triedPositions = false,
              openedWithTouch = false,
              element = this,
              instance = $module.data(moduleNamespace),
              elementNamespace,
              id,
              module;
          ;
          module = {
            initialize: function() {
              module.debug('Initializing', $module);
              module.createID();
              module.bind.events();
              if (!module.exists() && settings.preserve) {
                module.create();
              }
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance', module);
              instance = module;
              $module.data(moduleNamespace, instance);
              ;
            },
            refresh: function() {
              if (settings.popup) {
                $popup = $(settings.popup).eq(0);
              } else {
                if (settings.inline) {
                  $popup = $target.nextAll(selector.popup).eq(0);
                  settings.popup = $popup;
                }
              }
              if (settings.popup) {
                $popup.addClass(className.loading);
                $offsetParent = module.get.offsetParent();
                $popup.removeClass(className.loading);
                if (settings.movePopup && module.has.popup() && module.get.offsetParent($popup)[0] !== $offsetParent[0]) {
                  module.debug('Moving popup to the same offset parent as activating element');
                  $popup.detach().appendTo($offsetParent);
                  ;
                }
              } else {
                $offsetParent = (settings.inline) ? module.get.offsetParent($target) : module.has.popup() ? module.get.offsetParent($popup) : $body;
                ;
              }
              if ($offsetParent.is('html') && $offsetParent[0] !== $body[0]) {
                module.debug('Setting page as offset parent');
                $offsetParent = $body;
              }
              if (module.get.variation()) {
                module.set.variation();
              }
            },
            reposition: function() {
              module.refresh();
              module.set.position();
            },
            destroy: function() {
              module.debug('Destroying previous module');
              if ($popup && !settings.preserve) {
                module.removePopup();
              }
              clearTimeout(module.hideTimer);
              clearTimeout(module.showTimer);
              $window.off(elementNamespace);
              $module.off(eventNamespace).removeData(moduleNamespace);
              ;
            },
            event: {
              start: function(event) {
                var delay = ($.isPlainObject(settings.delay)) ? settings.delay.show : settings.delay;
                ;
                clearTimeout(module.hideTimer);
                if (!openedWithTouch) {
                  module.showTimer = setTimeout(module.show, delay);
                }
              },
              end: function() {
                var delay = ($.isPlainObject(settings.delay)) ? settings.delay.hide : settings.delay;
                ;
                clearTimeout(module.showTimer);
                module.hideTimer = setTimeout(module.hide, delay);
              },
              touchstart: function(event) {
                openedWithTouch = true;
                module.show();
              },
              resize: function() {
                if (module.is.visible()) {
                  module.set.position();
                }
              },
              hideGracefully: function(event) {
                if (event && $(event.target).closest(selector.popup).length === 0) {
                  module.debug('Click occurred outside popup hiding popup');
                  module.hide();
                } else {
                  module.debug('Click was inside popup, keeping popup open');
                }
              }
            },
            create: function() {
              var html = module.get.html(),
                  title = module.get.title(),
                  content = module.get.content();
              ;
              if (html || content || title) {
                module.debug('Creating pop-up html');
                if (!html) {
                  html = settings.templates.popup({
                    title: title,
                    content: content
                  });
                }
                $popup = $('<div/>').addClass(className.popup).data(metadata.activator, $module).html(html);
                ;
                if (settings.inline) {
                  module.verbose('Inserting popup element inline', $popup);
                  $popup.insertAfter($module);
                  ;
                } else {
                  module.verbose('Appending popup element to body', $popup);
                  $popup.appendTo($context);
                  ;
                }
                module.refresh();
                module.set.variation();
                if (settings.hoverable) {
                  module.bind.popup();
                }
                settings.onCreate.call($popup, element);
              } else if ($target.next(selector.popup).length !== 0) {
                module.verbose('Pre-existing popup found');
                settings.inline = true;
                settings.popups = $target.next(selector.popup).data(metadata.activator, $module);
                module.refresh();
                if (settings.hoverable) {
                  module.bind.popup();
                }
              } else if (settings.popup) {
                $(settings.popup).data(metadata.activator, $module);
                module.verbose('Used popup specified in settings');
                module.refresh();
                if (settings.hoverable) {
                  module.bind.popup();
                }
              } else {
                module.debug('No content specified skipping display', element);
              }
            },
            createID: function() {
              id = (Math.random().toString(16) + '000000000').substr(2, 8);
              elementNamespace = '.' + id;
              module.verbose('Creating unique id for element', id);
            },
            toggle: function() {
              module.debug('Toggling pop-up');
              if (module.is.hidden()) {
                module.debug('Popup is hidden, showing pop-up');
                module.unbind.close();
                module.show();
              } else {
                module.debug('Popup is visible, hiding pop-up');
                module.hide();
              }
            },
            show: function(callback) {
              callback = callback || function() {};
              module.debug('Showing pop-up', settings.transition);
              if (module.is.hidden() && !(module.is.active() && module.is.dropdown())) {
                if (!module.exists()) {
                  module.create();
                }
                if (settings.onShow.call($popup, element) === false) {
                  module.debug('onShow callback returned false, cancelling popup animation');
                  return;
                } else if (!settings.preserve && !settings.popup) {
                  module.refresh();
                }
                if ($popup && module.set.position()) {
                  module.save.conditions();
                  if (settings.exclusive) {
                    module.hideAll();
                  }
                  module.animate.show(callback);
                }
              }
            },
            hide: function(callback) {
              callback = callback || function() {};
              if (module.is.visible() || module.is.animating()) {
                if (settings.onHide.call($popup, element) === false) {
                  module.debug('onHide callback returned false, cancelling popup animation');
                  return;
                }
                module.remove.visible();
                module.unbind.close();
                module.restore.conditions();
                module.animate.hide(callback);
              }
            },
            hideAll: function() {
              $(selector.popup).filter('.' + className.visible).each(function() {
                $(this).data(metadata.activator).popup('hide');
                ;
              });
              ;
            },
            exists: function() {
              if (!$popup) {
                return false;
              }
              if (settings.inline || settings.popup) {
                return (module.has.popup());
              } else {
                return ($popup.closest($context).length >= 1) ? true : false;
                ;
              }
            },
            removePopup: function() {
              if (module.has.popup() && !settings.popup) {
                module.debug('Removing popup', $popup);
                $popup.remove();
                $popup = undefined;
                settings.onRemove.call($popup, element);
              }
            },
            save: {conditions: function() {
                module.cache = {title: $module.attr('title')};
                if (module.cache.title) {
                  $module.removeAttr('title');
                }
                module.verbose('Saving original attributes', module.cache.title);
              }},
            restore: {conditions: function() {
                if (module.cache && module.cache.title) {
                  $module.attr('title', module.cache.title);
                  module.verbose('Restoring original attributes', module.cache.title);
                }
                return true;
              }},
            animate: {
              show: function(callback) {
                callback = $.isFunction(callback) ? callback : function() {};
                if (settings.transition && $.fn.transition !== undefined && $module.transition('is supported')) {
                  module.set.visible();
                  $popup.transition({
                    animation: settings.transition + ' in',
                    queue: false,
                    debug: settings.debug,
                    verbose: settings.verbose,
                    duration: settings.duration,
                    onComplete: function() {
                      module.bind.close();
                      callback.call($popup, element);
                      settings.onVisible.call($popup, element);
                    }
                  });
                  ;
                } else {
                  module.error(error.noTransition);
                }
              },
              hide: function(callback) {
                callback = $.isFunction(callback) ? callback : function() {};
                module.debug('Hiding pop-up');
                if (settings.onHide.call($popup, element) === false) {
                  module.debug('onHide callback returned false, cancelling popup animation');
                  return;
                }
                if (settings.transition && $.fn.transition !== undefined && $module.transition('is supported')) {
                  $popup.transition({
                    animation: settings.transition + ' out',
                    queue: false,
                    duration: settings.duration,
                    debug: settings.debug,
                    verbose: settings.verbose,
                    onComplete: function() {
                      module.reset();
                      callback.call($popup, element);
                      settings.onHidden.call($popup, element);
                    }
                  });
                  ;
                } else {
                  module.error(error.noTransition);
                }
              }
            },
            get: {
              html: function() {
                $module.removeData(metadata.html);
                return $module.data(metadata.html) || settings.html;
              },
              title: function() {
                $module.removeData(metadata.title);
                return $module.data(metadata.title) || settings.title;
              },
              content: function() {
                $module.removeData(metadata.content);
                return $module.data(metadata.content) || $module.attr('title') || settings.content;
              },
              variation: function() {
                $module.removeData(metadata.variation);
                return $module.data(metadata.variation) || settings.variation;
              },
              popupOffset: function() {
                return $popup.offset();
              },
              calculations: function() {
                var targetElement = $target[0],
                    targetPosition = (settings.inline || settings.popup) ? $target.position() : $target.offset(),
                    calculations = {},
                    screen;
                ;
                calculations = {
                  target: {
                    element: $target[0],
                    width: $target.outerWidth(),
                    height: $target.outerHeight(),
                    top: targetPosition.top,
                    left: targetPosition.left,
                    margin: {}
                  },
                  popup: {
                    width: $popup.outerWidth(),
                    height: $popup.outerHeight()
                  },
                  parent: {
                    width: $offsetParent.outerWidth(),
                    height: $offsetParent.outerHeight()
                  },
                  screen: {
                    scroll: {
                      top: $window.scrollTop(),
                      left: $window.scrollLeft()
                    },
                    width: $window.width(),
                    height: $window.height()
                  }
                };
                if (settings.setFluidWidth && module.is.fluid()) {
                  calculations.container = {width: $popup.parent().outerWidth()};
                  calculations.popup.width = calculations.container.width;
                }
                calculations.target.margin.top = (settings.inline) ? parseInt(window.getComputedStyle(targetElement).getPropertyValue('margin-top'), 10) : 0;
                ;
                calculations.target.margin.left = (settings.inline) ? module.is.rtl() ? parseInt(window.getComputedStyle(targetElement).getPropertyValue('margin-right'), 10) : parseInt(window.getComputedStyle(targetElement).getPropertyValue('margin-left'), 10) : 0;
                ;
                screen = calculations.screen;
                calculations.boundary = {
                  top: screen.scroll.top,
                  bottom: screen.scroll.top + screen.height,
                  left: screen.scroll.left,
                  right: screen.scroll.left + screen.width
                };
                return calculations;
              },
              id: function() {
                return id;
              },
              startEvent: function() {
                if (settings.on == 'hover') {
                  return 'mouseenter';
                } else if (settings.on == 'focus') {
                  return 'focus';
                }
                return false;
              },
              scrollEvent: function() {
                return 'scroll';
              },
              endEvent: function() {
                if (settings.on == 'hover') {
                  return 'mouseleave';
                } else if (settings.on == 'focus') {
                  return 'blur';
                }
                return false;
              },
              distanceFromBoundary: function(offset, calculations) {
                var distanceFromBoundary = {},
                    popup,
                    boundary;
                ;
                offset = offset || module.get.offset();
                calculations = calculations || module.get.calculations();
                popup = calculations.popup;
                boundary = calculations.boundary;
                if (offset) {
                  distanceFromBoundary = {
                    top: (offset.top - boundary.top),
                    left: (offset.left - boundary.left),
                    right: (boundary.right - (offset.left + popup.width)),
                    bottom: (boundary.bottom - (offset.top + popup.height))
                  };
                  module.verbose('Distance from boundaries determined', offset, distanceFromBoundary);
                }
                return distanceFromBoundary;
              },
              offsetParent: function($target) {
                var element = ($target !== undefined) ? $target[0] : $module[0],
                    parentNode = element.parentNode,
                    $node = $(parentNode);
                ;
                if (parentNode) {
                  var is2D = ($node.css('transform') === 'none'),
                      isStatic = ($node.css('position') === 'static'),
                      isHTML = $node.is('html');
                  ;
                  while (parentNode && !isHTML && isStatic && is2D) {
                    parentNode = parentNode.parentNode;
                    $node = $(parentNode);
                    is2D = ($node.css('transform') === 'none');
                    isStatic = ($node.css('position') === 'static');
                    isHTML = $node.is('html');
                  }
                }
                return ($node && $node.length > 0) ? $node : $();
                ;
              },
              positions: function() {
                return {
                  'top left': false,
                  'top center': false,
                  'top right': false,
                  'bottom left': false,
                  'bottom center': false,
                  'bottom right': false,
                  'left center': false,
                  'right center': false
                };
              },
              nextPosition: function(position) {
                var positions = position.split(' '),
                    verticalPosition = positions[0],
                    horizontalPosition = positions[1],
                    opposite = {
                      top: 'bottom',
                      bottom: 'top',
                      left: 'right',
                      right: 'left'
                    },
                    adjacent = {
                      left: 'center',
                      center: 'right',
                      right: 'left'
                    },
                    backup = {
                      'top left': 'top center',
                      'top center': 'top right',
                      'top right': 'right center',
                      'right center': 'bottom right',
                      'bottom right': 'bottom center',
                      'bottom center': 'bottom left',
                      'bottom left': 'left center',
                      'left center': 'top left'
                    },
                    adjacentsAvailable = (verticalPosition == 'top' || verticalPosition == 'bottom'),
                    oppositeTried = false,
                    adjacentTried = false,
                    nextPosition = false;
                ;
                if (!triedPositions) {
                  module.verbose('All available positions available');
                  triedPositions = module.get.positions();
                }
                module.debug('Recording last position tried', position);
                triedPositions[position] = true;
                if (settings.prefer === 'opposite') {
                  nextPosition = [opposite[verticalPosition], horizontalPosition];
                  nextPosition = nextPosition.join(' ');
                  oppositeTried = (triedPositions[nextPosition] === true);
                  module.debug('Trying opposite strategy', nextPosition);
                }
                if ((settings.prefer === 'adjacent') && adjacentsAvailable) {
                  nextPosition = [verticalPosition, adjacent[horizontalPosition]];
                  nextPosition = nextPosition.join(' ');
                  adjacentTried = (triedPositions[nextPosition] === true);
                  module.debug('Trying adjacent strategy', nextPosition);
                }
                if (adjacentTried || oppositeTried) {
                  module.debug('Using backup position', nextPosition);
                  nextPosition = backup[position];
                }
                return nextPosition;
              }
            },
            set: {
              position: function(position, calculations) {
                if ($target.length === 0 || $popup.length === 0) {
                  module.error(error.notFound);
                  return;
                }
                var offset,
                    distanceAway,
                    target,
                    popup,
                    parent,
                    positioning,
                    popupOffset,
                    distanceFromBoundary;
                ;
                calculations = calculations || module.get.calculations();
                position = position || $module.data(metadata.position) || settings.position;
                offset = $module.data(metadata.offset) || settings.offset;
                distanceAway = settings.distanceAway;
                target = calculations.target;
                popup = calculations.popup;
                parent = calculations.parent;
                if (target.width === 0 && target.height === 0) {
                  module.debug('Popup target is hidden, no action taken');
                  return false;
                }
                if (settings.inline) {
                  module.debug('Adding margin to calculation', target.margin);
                  if (position == 'left center' || position == 'right center') {
                    offset += target.margin.top;
                    distanceAway += -target.margin.left;
                  } else if (position == 'top left' || position == 'top center' || position == 'top right') {
                    offset += target.margin.left;
                    distanceAway -= target.margin.top;
                  } else {
                    offset += target.margin.left;
                    distanceAway += target.margin.top;
                  }
                }
                module.debug('Determining popup position from calculations', position, calculations);
                if (module.is.rtl()) {
                  position = position.replace(/left|right/g, function(match) {
                    return (match == 'left') ? 'right' : 'left';
                    ;
                  });
                  module.debug('RTL: Popup position updated', position);
                }
                if (searchDepth == settings.maxSearchDepth && typeof settings.lastResort === 'string') {
                  position = settings.lastResort;
                }
                switch (position) {
                  case 'top left':
                    positioning = {
                      top: 'auto',
                      bottom: parent.height - target.top + distanceAway,
                      left: target.left + offset,
                      right: 'auto'
                    };
                    break;
                  case 'top center':
                    positioning = {
                      bottom: parent.height - target.top + distanceAway,
                      left: target.left + (target.width / 2) - (popup.width / 2) + offset,
                      top: 'auto',
                      right: 'auto'
                    };
                    break;
                  case 'top right':
                    positioning = {
                      bottom: parent.height - target.top + distanceAway,
                      right: parent.width - target.left - target.width - offset,
                      top: 'auto',
                      left: 'auto'
                    };
                    break;
                  case 'left center':
                    positioning = {
                      top: target.top + (target.height / 2) - (popup.height / 2) + offset,
                      right: parent.width - target.left + distanceAway,
                      left: 'auto',
                      bottom: 'auto'
                    };
                    break;
                  case 'right center':
                    positioning = {
                      top: target.top + (target.height / 2) - (popup.height / 2) + offset,
                      left: target.left + target.width + distanceAway,
                      bottom: 'auto',
                      right: 'auto'
                    };
                    break;
                  case 'bottom left':
                    positioning = {
                      top: target.top + target.height + distanceAway,
                      left: target.left + offset,
                      bottom: 'auto',
                      right: 'auto'
                    };
                    break;
                  case 'bottom center':
                    positioning = {
                      top: target.top + target.height + distanceAway,
                      left: target.left + (target.width / 2) - (popup.width / 2) + offset,
                      bottom: 'auto',
                      right: 'auto'
                    };
                    break;
                  case 'bottom right':
                    positioning = {
                      top: target.top + target.height + distanceAway,
                      right: parent.width - target.left - target.width - offset,
                      left: 'auto',
                      bottom: 'auto'
                    };
                    break;
                }
                if (positioning === undefined) {
                  module.error(error.invalidPosition, position);
                }
                module.debug('Calculated popup positioning values', positioning);
                $popup.css(positioning).removeClass(className.position).addClass(position).addClass(className.loading);
                ;
                popupOffset = module.get.popupOffset();
                distanceFromBoundary = module.get.distanceFromBoundary(popupOffset, calculations);
                if (module.is.offstage(distanceFromBoundary, position)) {
                  module.debug('Position is outside viewport', position);
                  if (searchDepth < settings.maxSearchDepth) {
                    searchDepth++;
                    position = module.get.nextPosition(position);
                    module.debug('Trying new position', position);
                    return ($popup) ? module.set.position(position, calculations) : false;
                    ;
                  } else {
                    if (settings.lastResort) {
                      module.debug('No position found, showing with last position');
                    } else {
                      module.debug('Popup could not find a position to display', $popup);
                      module.error(error.cannotPlace, element);
                      module.remove.attempts();
                      module.remove.loading();
                      module.reset();
                      return false;
                    }
                  }
                }
                module.debug('Position is on stage', position);
                module.remove.attempts();
                module.remove.loading();
                if (settings.setFluidWidth && module.is.fluid()) {
                  module.set.fluidWidth(calculations);
                }
                return true;
              },
              fluidWidth: function(calculations) {
                calculations = calculations || module.get.calculations();
                module.debug('Automatically setting element width to parent width', calculations.parent.width);
                $popup.css('width', calculations.container.width);
              },
              variation: function(variation) {
                variation = variation || module.get.variation();
                if (variation && module.has.popup()) {
                  module.verbose('Adding variation to popup', variation);
                  $popup.addClass(variation);
                }
              },
              visible: function() {
                $module.addClass(className.visible);
              }
            },
            remove: {
              loading: function() {
                $popup.removeClass(className.loading);
              },
              variation: function(variation) {
                variation = variation || module.get.variation();
                if (variation) {
                  module.verbose('Removing variation', variation);
                  $popup.removeClass(variation);
                }
              },
              visible: function() {
                $module.removeClass(className.visible);
              },
              attempts: function() {
                module.verbose('Resetting all searched positions');
                searchDepth = 0;
                triedPositions = false;
              }
            },
            bind: {
              events: function() {
                module.debug('Binding popup events to module');
                if (settings.on == 'click') {
                  $module.on('click' + eventNamespace, module.toggle);
                  ;
                }
                if (settings.on == 'hover' && hasTouch) {
                  $module.on('touchstart' + eventNamespace, module.event.touchstart);
                  ;
                }
                if (module.get.startEvent()) {
                  $module.on(module.get.startEvent() + eventNamespace, module.event.start).on(module.get.endEvent() + eventNamespace, module.event.end);
                  ;
                }
                if (settings.target) {
                  module.debug('Target set to element', $target);
                }
                $window.on('resize' + elementNamespace, module.event.resize);
              },
              popup: function() {
                module.verbose('Allowing hover events on popup to prevent closing');
                if ($popup && module.has.popup()) {
                  $popup.on('mouseenter' + eventNamespace, module.event.start).on('mouseleave' + eventNamespace, module.event.end);
                  ;
                }
              },
              close: function() {
                if (settings.hideOnScroll === true || (settings.hideOnScroll == 'auto' && settings.on != 'click')) {
                  $document.one(module.get.scrollEvent() + elementNamespace, module.event.hideGracefully);
                  ;
                  $context.one(module.get.scrollEvent() + elementNamespace, module.event.hideGracefully);
                  ;
                }
                if (settings.on == 'hover' && openedWithTouch) {
                  module.verbose('Binding popup close event to document');
                  $document.on('touchstart' + elementNamespace, function(event) {
                    module.verbose('Touched away from popup');
                    module.event.hideGracefully.call(element, event);
                  });
                  ;
                }
                if (settings.on == 'click' && settings.closable) {
                  module.verbose('Binding popup close event to document');
                  $document.on('click' + elementNamespace, function(event) {
                    module.verbose('Clicked away from popup');
                    module.event.hideGracefully.call(element, event);
                  });
                  ;
                }
              }
            },
            unbind: {close: function() {
                if (settings.hideOnScroll === true || (settings.hideOnScroll == 'auto' && settings.on != 'click')) {
                  $document.off('scroll' + elementNamespace, module.hide);
                  ;
                  $context.off('scroll' + elementNamespace, module.hide);
                  ;
                }
                if (settings.on == 'hover' && openedWithTouch) {
                  $document.off('touchstart' + elementNamespace);
                  ;
                  openedWithTouch = false;
                }
                if (settings.on == 'click' && settings.closable) {
                  module.verbose('Removing close event from document');
                  $document.off('click' + elementNamespace);
                  ;
                }
              }},
            has: {popup: function() {
                return ($popup && $popup.length > 0);
              }},
            is: {
              offstage: function(distanceFromBoundary, position) {
                var offstage = [];
                ;
                $.each(distanceFromBoundary, function(direction, distance) {
                  if (distance < -settings.jitter) {
                    module.debug('Position exceeds allowable distance from edge', direction, distance, position);
                    offstage.push(direction);
                  }
                });
                if (offstage.length > 0) {
                  return true;
                } else {
                  return false;
                }
              },
              active: function() {
                return $module.hasClass(className.active);
              },
              animating: function() {
                return ($popup && $popup.hasClass(className.animating));
              },
              fluid: function() {
                return ($popup && $popup.hasClass(className.fluid));
              },
              visible: function() {
                return $popup && $popup.hasClass(className.visible);
              },
              dropdown: function() {
                return $module.hasClass(className.dropdown);
              },
              hidden: function() {
                return !module.is.visible();
              },
              rtl: function() {
                return $module.css('direction') == 'rtl';
              }
            },
            reset: function() {
              module.remove.visible();
              if (settings.preserve) {
                if ($.fn.transition !== undefined) {
                  $popup.transition('remove transition');
                  ;
                }
              } else {
                module.removePopup();
              }
            },
            setting: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.popup.settings = {
        name: 'Popup',
        debug: false,
        verbose: false,
        performance: true,
        namespace: 'popup',
        onCreate: function() {},
        onRemove: function() {},
        onShow: function() {},
        onVisible: function() {},
        onHide: function() {},
        onHidden: function() {},
        on: 'hover',
        addTouchEvents: true,
        position: 'top left',
        variation: '',
        movePopup: true,
        target: false,
        popup: false,
        inline: false,
        preserve: false,
        hoverable: false,
        content: false,
        html: false,
        title: false,
        closable: true,
        hideOnScroll: 'auto',
        exclusive: false,
        context: 'body',
        prefer: 'opposite',
        lastResort: false,
        delay: {
          show: 50,
          hide: 70
        },
        setFluidWidth: true,
        duration: 200,
        transition: 'scale',
        distanceAway: 0,
        jitter: 2,
        offset: 0,
        maxSearchDepth: 15,
        error: {
          invalidPosition: 'The position you specified is not a valid position',
          cannotPlace: 'Popup does not fit within the boundaries of the viewport',
          method: 'The method you called is not defined.',
          noTransition: 'This module requires ui transitions <https://github.com/Semantic-Org/UI-Transition>',
          notFound: 'The target or popup you specified does not exist on the page'
        },
        metadata: {
          activator: 'activator',
          content: 'content',
          html: 'html',
          offset: 'offset',
          position: 'position',
          title: 'title',
          variation: 'variation'
        },
        className: {
          active: 'active',
          animating: 'animating',
          dropdown: 'dropdown',
          fluid: 'fluid',
          loading: 'loading',
          popup: 'ui popup',
          position: 'top left center bottom right',
          visible: 'visible'
        },
        selector: {popup: '.ui.popup'},
        templates: {
          escape: function(string) {
            var badChars = /[&<>"'`]/g,
                shouldEscape = /[&<>"'`]/,
                escape = {
                  "&": "&amp;",
                  "<": "&lt;",
                  ">": "&gt;",
                  '"': "&quot;",
                  "'": "&#x27;",
                  "`": "&#x60;"
                },
                escapedChar = function(chr) {
                  return escape[chr];
                };
            ;
            if (shouldEscape.test(string)) {
              return string.replace(badChars, escapedChar);
            }
            return string;
          },
          popup: function(text) {
            var html = '',
                escape = $.fn.popup.settings.templates.escape;
            ;
            if (typeof text !== undefined) {
              if (typeof text.title !== undefined && text.title) {
                text.title = escape(text.title);
                html += '<div class="header">' + text.title + '</div>';
              }
              if (typeof text.content !== undefined && text.content) {
                text.content = escape(text.content);
                html += '<div class="content">' + text.content + '</div>';
              }
            }
            return html;
          }
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.progress = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.progress.settings, parameters) : $.extend({}, $.fn.progress.settings),
              className = settings.className,
              metadata = settings.metadata,
              namespace = settings.namespace,
              selector = settings.selector,
              error = settings.error,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $module = $(this),
              $bar = $(this).find(selector.bar),
              $progress = $(this).find(selector.progress),
              $label = $(this).find(selector.label),
              element = this,
              instance = $module.data(moduleNamespace),
              animating = false,
              transitionEnd,
              module;
          ;
          module = {
            initialize: function() {
              module.debug('Initializing progress bar', settings);
              module.set.duration();
              module.set.transitionEvent();
              module.read.metadata();
              module.read.settings();
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of progress', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous progress for', $module);
              clearInterval(instance.interval);
              module.remove.state();
              $module.removeData(moduleNamespace);
              instance = undefined;
            },
            reset: function() {
              module.set.percent(0);
            },
            complete: function() {
              if (module.percent === undefined || module.percent < 100) {
                module.set.percent(100);
              }
            },
            read: {
              metadata: function() {
                var data = {
                  percent: $module.data(metadata.percent),
                  total: $module.data(metadata.total),
                  value: $module.data(metadata.value)
                };
                ;
                if (data.percent) {
                  module.debug('Current percent value set from metadata', data.percent);
                  module.set.percent(data.percent);
                }
                if (data.total) {
                  module.debug('Total value set from metadata', data.total);
                  module.set.total(data.total);
                }
                if (data.value) {
                  module.debug('Current value set from metadata', data.value);
                  module.set.value(data.value);
                  module.set.progress(data.value);
                }
              },
              settings: function() {
                if (settings.total !== false) {
                  module.debug('Current total set in settings', settings.total);
                  module.set.total(settings.total);
                }
                if (settings.value !== false) {
                  module.debug('Current value set in settings', settings.value);
                  module.set.value(settings.value);
                  module.set.progress(module.value);
                }
                if (settings.percent !== false) {
                  module.debug('Current percent set in settings', settings.percent);
                  module.set.percent(settings.percent);
                }
              }
            },
            increment: function(incrementValue) {
              var maxValue,
                  startValue,
                  newValue;
              ;
              if (module.has.total()) {
                startValue = module.get.value();
                incrementValue = incrementValue || 1;
                newValue = startValue + incrementValue;
                maxValue = module.get.total();
                module.debug('Incrementing value', startValue, newValue, maxValue);
                if (newValue > maxValue) {
                  module.debug('Value cannot increment above total', maxValue);
                  newValue = maxValue;
                }
              } else {
                startValue = module.get.percent();
                incrementValue = incrementValue || module.get.randomValue();
                newValue = startValue + incrementValue;
                maxValue = 100;
                module.debug('Incrementing percentage by', startValue, newValue);
                if (newValue > maxValue) {
                  module.debug('Value cannot increment above 100 percent');
                  newValue = maxValue;
                }
              }
              module.set.progress(newValue);
            },
            decrement: function(decrementValue) {
              var total = module.get.total(),
                  startValue,
                  newValue;
              ;
              if (total) {
                startValue = module.get.value();
                decrementValue = decrementValue || 1;
                newValue = startValue - decrementValue;
                module.debug('Decrementing value by', decrementValue, startValue);
              } else {
                startValue = module.get.percent();
                decrementValue = decrementValue || module.get.randomValue();
                newValue = startValue - decrementValue;
                module.debug('Decrementing percentage by', decrementValue, startValue);
              }
              if (newValue < 0) {
                module.debug('Value cannot decrement below 0');
                newValue = 0;
              }
              module.set.progress(newValue);
            },
            has: {total: function() {
                return (module.get.total() !== false);
              }},
            get: {
              text: function(templateText) {
                var value = module.value || 0,
                    total = module.total || 0,
                    percent = (animating) ? module.get.displayPercent() : module.percent || 0,
                    left = (module.total > 0) ? (total - value) : (100 - percent);
                ;
                templateText = templateText || '';
                templateText = templateText.replace('{value}', value).replace('{total}', total).replace('{left}', left).replace('{percent}', percent);
                ;
                module.debug('Adding variables to progress bar text', templateText);
                return templateText;
              },
              randomValue: function() {
                module.debug('Generating random increment percentage');
                return Math.floor((Math.random() * settings.random.max) + settings.random.min);
              },
              numericValue: function(value) {
                return (typeof value === 'string') ? (value.replace(/[^\d.]/g, '') !== '') ? +(value.replace(/[^\d.]/g, '')) : false : value;
                ;
              },
              transitionEnd: function() {
                var element = document.createElement('element'),
                    transitions = {
                      'transition': 'transitionend',
                      'OTransition': 'oTransitionEnd',
                      'MozTransition': 'transitionend',
                      'WebkitTransition': 'webkitTransitionEnd'
                    },
                    transition;
                ;
                for (transition in transitions) {
                  if (element.style[transition] !== undefined) {
                    return transitions[transition];
                  }
                }
              },
              displayPercent: function() {
                var barWidth = $bar.width(),
                    totalWidth = $module.width(),
                    minDisplay = parseInt($bar.css('min-width'), 10),
                    displayPercent = (barWidth > minDisplay) ? (barWidth / totalWidth * 100) : module.percent;
                ;
                return (settings.precision > 0) ? Math.round(displayPercent * (10 * settings.precision)) / (10 * settings.precision) : Math.round(displayPercent);
                ;
              },
              percent: function() {
                return module.percent || 0;
              },
              value: function() {
                return module.value || 0;
              },
              total: function() {
                return module.total || false;
              }
            },
            is: {
              success: function() {
                return $module.hasClass(className.success);
              },
              warning: function() {
                return $module.hasClass(className.warning);
              },
              error: function() {
                return $module.hasClass(className.error);
              },
              active: function() {
                return $module.hasClass(className.active);
              },
              visible: function() {
                return $module.is(':visible');
              }
            },
            remove: {
              state: function() {
                module.verbose('Removing stored state');
                delete module.total;
                delete module.percent;
                delete module.value;
              },
              active: function() {
                module.verbose('Removing active state');
                $module.removeClass(className.active);
              },
              success: function() {
                module.verbose('Removing success state');
                $module.removeClass(className.success);
              },
              warning: function() {
                module.verbose('Removing warning state');
                $module.removeClass(className.warning);
              },
              error: function() {
                module.verbose('Removing error state');
                $module.removeClass(className.error);
              }
            },
            set: {
              barWidth: function(value) {
                if (value > 100) {
                  module.error(error.tooHigh, value);
                } else if (value < 0) {
                  module.error(error.tooLow, value);
                } else {
                  $bar.css('width', value + '%');
                  ;
                  $module.attr('data-percent', parseInt(value, 10));
                  ;
                }
              },
              duration: function(duration) {
                duration = duration || settings.duration;
                duration = (typeof duration == 'number') ? duration + 'ms' : duration;
                ;
                module.verbose('Setting progress bar transition duration', duration);
                $bar.css({'transition-duration': duration});
                ;
              },
              percent: function(percent) {
                percent = (typeof percent == 'string') ? +(percent.replace('%', '')) : percent;
                ;
                percent = (settings.precision > 0) ? Math.round(percent * (10 * settings.precision)) / (10 * settings.precision) : Math.round(percent);
                ;
                module.percent = percent;
                if (!module.has.total()) {
                  module.value = (settings.precision > 0) ? Math.round((percent / 100) * module.total * (10 * settings.precision)) / (10 * settings.precision) : Math.round((percent / 100) * module.total * 10) / 10;
                  ;
                  if (settings.limitValues) {
                    module.value = (module.value > 100) ? 100 : (module.value < 0) ? 0 : module.value;
                    ;
                  }
                }
                module.set.barWidth(percent);
                module.set.labelInterval();
                module.set.labels();
                settings.onChange.call(element, percent, module.value, module.total);
              },
              labelInterval: function() {
                var animationCallback = function() {
                  module.verbose('Bar finished animating, removing continuous label updates');
                  clearInterval(module.interval);
                  animating = false;
                  module.set.labels();
                };
                ;
                clearInterval(module.interval);
                $bar.one(transitionEnd + eventNamespace, animationCallback);
                module.timer = setTimeout(animationCallback, settings.duration + 100);
                animating = true;
                module.interval = setInterval(module.set.labels, settings.framerate);
              },
              labels: function() {
                module.verbose('Setting both bar progress and outer label text');
                module.set.barLabel();
                module.set.state();
              },
              label: function(text) {
                text = text || '';
                if (text) {
                  text = module.get.text(text);
                  module.debug('Setting label to text', text);
                  $label.text(text);
                }
              },
              state: function(percent) {
                percent = (percent !== undefined) ? percent : module.percent;
                ;
                if (percent === 100) {
                  if (settings.autoSuccess && !(module.is.warning() || module.is.error())) {
                    module.set.success();
                    module.debug('Automatically triggering success at 100%');
                  } else {
                    module.verbose('Reached 100% removing active state');
                    module.remove.active();
                  }
                } else if (percent > 0) {
                  module.verbose('Adjusting active progress bar label', percent);
                  module.set.active();
                } else {
                  module.remove.active();
                  module.set.label(settings.text.active);
                }
              },
              barLabel: function(text) {
                if (text !== undefined) {
                  $progress.text(module.get.text(text));
                } else if (settings.label == 'ratio' && module.total) {
                  module.debug('Adding ratio to bar label');
                  $progress.text(module.get.text(settings.text.ratio));
                } else if (settings.label == 'percent') {
                  module.debug('Adding percentage to bar label');
                  $progress.text(module.get.text(settings.text.percent));
                }
              },
              active: function(text) {
                text = text || settings.text.active;
                module.debug('Setting active state');
                if (settings.showActivity && !module.is.active()) {
                  $module.addClass(className.active);
                }
                module.remove.warning();
                module.remove.error();
                module.remove.success();
                if (text) {
                  module.set.label(text);
                }
                settings.onActive.call(element, module.value, module.total);
              },
              success: function(text) {
                text = text || settings.text.success;
                module.debug('Setting success state');
                $module.addClass(className.success);
                module.remove.active();
                module.remove.warning();
                module.remove.error();
                module.complete();
                if (text) {
                  module.set.label(text);
                }
                settings.onSuccess.call(element, module.total);
              },
              warning: function(text) {
                text = text || settings.text.warning;
                module.debug('Setting warning state');
                $module.addClass(className.warning);
                module.remove.active();
                module.remove.success();
                module.remove.error();
                module.complete();
                if (text) {
                  module.set.label(text);
                }
                settings.onWarning.call(element, module.value, module.total);
              },
              error: function(text) {
                text = text || settings.text.error;
                module.debug('Setting error state');
                $module.addClass(className.error);
                module.remove.active();
                module.remove.success();
                module.remove.warning();
                module.complete();
                if (text) {
                  module.set.label(text);
                }
                settings.onError.call(element, module.value, module.total);
              },
              transitionEvent: function() {
                transitionEnd = module.get.transitionEnd();
              },
              total: function(totalValue) {
                module.total = totalValue;
              },
              value: function(value) {
                module.value = value;
              },
              progress: function(value) {
                var numericValue = module.get.numericValue(value),
                    percentComplete;
                ;
                if (numericValue === false) {
                  module.error(error.nonNumeric, value);
                }
                if (module.has.total()) {
                  module.set.value(numericValue);
                  percentComplete = (numericValue / module.total) * 100;
                  module.debug('Calculating percent complete from total', percentComplete);
                  module.set.percent(percentComplete);
                } else {
                  percentComplete = numericValue;
                  module.debug('Setting value to exact percentage value', percentComplete);
                  module.set.percent(percentComplete);
                }
              }
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.progress.settings = {
        name: 'Progress',
        namespace: 'progress',
        debug: false,
        verbose: false,
        performance: true,
        random: {
          min: 2,
          max: 5
        },
        duration: 300,
        autoSuccess: true,
        showActivity: true,
        limitValues: true,
        label: 'percent',
        precision: 0,
        framerate: (1000 / 30),
        percent: false,
        total: false,
        value: false,
        onChange: function(percent, value, total) {},
        onSuccess: function(total) {},
        onActive: function(value, total) {},
        onError: function(value, total) {},
        onWarning: function(value, total) {},
        error: {
          method: 'The method you called is not defined.',
          nonNumeric: 'Progress value is non numeric',
          tooHigh: 'Value specified is above 100%',
          tooLow: 'Value specified is below 0%'
        },
        regExp: {variable: /\{\$*[A-z0-9]+\}/g},
        metadata: {
          percent: 'percent',
          total: 'total',
          value: 'value'
        },
        selector: {
          bar: '> .bar',
          label: '> .label',
          progress: '.bar > .progress'
        },
        text: {
          active: false,
          error: false,
          success: false,
          warning: false,
          percent: '{percent}%',
          ratio: '{value} of {total}'
        },
        className: {
          active: 'active',
          error: 'error',
          success: 'success',
          warning: 'warning'
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.rating = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.rating.settings, parameters) : $.extend({}, $.fn.rating.settings),
              namespace = settings.namespace,
              className = settings.className,
              metadata = settings.metadata,
              selector = settings.selector,
              error = settings.error,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              element = this,
              instance = $(this).data(moduleNamespace),
              $module = $(this),
              $icon = $module.find(selector.icon),
              module;
          ;
          module = {
            initialize: function() {
              module.verbose('Initializing rating module', settings);
              if ($icon.length === 0) {
                module.setup.layout();
              }
              if (settings.interactive) {
                module.enable();
              } else {
                module.disable();
              }
              module.set.rating(module.get.initialRating());
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Instantiating module', settings);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous instance', instance);
              module.remove.events();
              $module.removeData(moduleNamespace);
              ;
            },
            refresh: function() {
              $icon = $module.find(selector.icon);
            },
            setup: {layout: function() {
                var maxRating = module.get.maxRating(),
                    html = $.fn.rating.settings.templates.icon(maxRating);
                ;
                module.debug('Generating icon html dynamically');
                $module.html(html);
                ;
                module.refresh();
              }},
            event: {
              mouseenter: function() {
                var $activeIcon = $(this);
                ;
                $activeIcon.nextAll().removeClass(className.selected);
                ;
                $module.addClass(className.selected);
                ;
                $activeIcon.addClass(className.selected).prevAll().addClass(className.selected);
                ;
              },
              mouseleave: function() {
                $module.removeClass(className.selected);
                ;
                $icon.removeClass(className.selected);
                ;
              },
              click: function() {
                var $activeIcon = $(this),
                    currentRating = module.get.rating(),
                    rating = $icon.index($activeIcon) + 1,
                    canClear = (settings.clearable == 'auto') ? ($icon.length === 1) : settings.clearable;
                ;
                if (canClear && currentRating == rating) {
                  module.clearRating();
                } else {
                  module.set.rating(rating);
                }
              }
            },
            clearRating: function() {
              module.debug('Clearing current rating');
              module.set.rating(0);
            },
            bind: {events: function() {
                module.verbose('Binding events');
                $module.on('mouseenter' + eventNamespace, selector.icon, module.event.mouseenter).on('mouseleave' + eventNamespace, selector.icon, module.event.mouseleave).on('click' + eventNamespace, selector.icon, module.event.click);
                ;
              }},
            remove: {events: function() {
                module.verbose('Removing events');
                $module.off(eventNamespace);
                ;
              }},
            enable: function() {
              module.debug('Setting rating to interactive mode');
              module.bind.events();
              $module.removeClass(className.disabled);
              ;
            },
            disable: function() {
              module.debug('Setting rating to read-only mode');
              module.remove.events();
              $module.addClass(className.disabled);
              ;
            },
            get: {
              initialRating: function() {
                if ($module.data(metadata.rating) !== undefined) {
                  $module.removeData(metadata.rating);
                  return $module.data(metadata.rating);
                }
                return settings.initialRating;
              },
              maxRating: function() {
                if ($module.data(metadata.maxRating) !== undefined) {
                  $module.removeData(metadata.maxRating);
                  return $module.data(metadata.maxRating);
                }
                return settings.maxRating;
              },
              rating: function() {
                var currentRating = $icon.filter('.' + className.active).length;
                ;
                module.verbose('Current rating retrieved', currentRating);
                return currentRating;
              }
            },
            set: {rating: function(rating) {
                var ratingIndex = (rating - 1 >= 0) ? (rating - 1) : 0,
                    $activeIcon = $icon.eq(ratingIndex);
                ;
                $module.removeClass(className.selected);
                ;
                $icon.removeClass(className.selected).removeClass(className.active);
                ;
                if (rating > 0) {
                  module.verbose('Setting current rating to', rating);
                  $activeIcon.prevAll().andSelf().addClass(className.active);
                  ;
                }
                settings.onRate.call(element, rating);
              }},
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ($allModules.length > 1) {
                  title += ' ' + '(' + $allModules.length + ')';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.rating.settings = {
        name: 'Rating',
        namespace: 'rating',
        debug: false,
        verbose: false,
        performance: true,
        initialRating: 0,
        interactive: true,
        maxRating: 4,
        clearable: 'auto',
        onRate: function(rating) {},
        error: {
          method: 'The method you called is not defined',
          noMaximum: 'No maximum rating specified. Cannot generate HTML automatically'
        },
        metadata: {
          rating: 'rating',
          maxRating: 'maxRating'
        },
        className: {
          active: 'active',
          disabled: 'disabled',
          selected: 'selected',
          loading: 'loading'
        },
        selector: {icon: '.icon'},
        templates: {icon: function(maxRating) {
            var icon = 1,
                html = '';
            ;
            while (icon <= maxRating) {
              html += '<i class="icon"></i>';
              icon++;
            }
            return html;
          }}
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.search = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $(this).each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.search.settings, parameters) : $.extend({}, $.fn.search.settings),
              className = settings.className,
              metadata = settings.metadata,
              regExp = settings.regExp,
              fields = settings.fields,
              selector = settings.selector,
              error = settings.error,
              namespace = settings.namespace,
              eventNamespace = '.' + namespace,
              moduleNamespace = namespace + '-module',
              $module = $(this),
              $prompt = $module.find(selector.prompt),
              $searchButton = $module.find(selector.searchButton),
              $results = $module.find(selector.results),
              $result = $module.find(selector.result),
              $category = $module.find(selector.category),
              element = this,
              instance = $module.data(moduleNamespace),
              module;
          ;
          module = {
            initialize: function() {
              module.verbose('Initializing module');
              module.determine.searchFields();
              module.bind.events();
              module.set.type();
              module.create.results();
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.verbose('Destroying instance');
              $module.off(eventNamespace).removeData(moduleNamespace);
              ;
            },
            bind: {events: function() {
                module.verbose('Binding events to search');
                if (settings.automatic) {
                  $module.on(module.get.inputEvent() + eventNamespace, selector.prompt, module.event.input);
                  ;
                  $prompt.attr('autocomplete', 'off');
                  ;
                }
                $module.on('focus' + eventNamespace, selector.prompt, module.event.focus).on('blur' + eventNamespace, selector.prompt, module.event.blur).on('keydown' + eventNamespace, selector.prompt, module.handleKeyboard).on('click' + eventNamespace, selector.searchButton, module.query).on('mousedown' + eventNamespace, selector.results, module.event.result.mousedown).on('mouseup' + eventNamespace, selector.results, module.event.result.mouseup).on('click' + eventNamespace, selector.result, module.event.result.click);
                ;
              }},
            determine: {searchFields: function() {
                if (parameters && parameters.searchFields !== undefined) {
                  settings.searchFields = parameters.searchFields;
                }
              }},
            event: {
              input: function() {
                clearTimeout(module.timer);
                module.timer = setTimeout(module.query, settings.searchDelay);
              },
              focus: function() {
                module.set.focus();
                if (module.has.minimumCharacters()) {
                  module.query();
                  if (module.can.show()) {
                    module.showResults();
                  }
                }
              },
              blur: function(event) {
                var pageLostFocus = (document.activeElement === this);
                ;
                if (!pageLostFocus && !module.resultsClicked) {
                  module.cancel.query();
                  module.remove.focus();
                  module.timer = setTimeout(module.hideResults, settings.hideDelay);
                }
              },
              result: {
                mousedown: function() {
                  module.resultsClicked = true;
                },
                mouseup: function() {
                  module.resultsClicked = false;
                },
                click: function(event) {
                  module.debug('Search result selected');
                  var $result = $(this),
                      $title = $result.find(selector.title).eq(0),
                      $link = $result.find('a[href]').eq(0),
                      href = $link.attr('href') || false,
                      target = $link.attr('target') || false,
                      title = $title.html(),
                      value = ($title.length > 0) ? $title.text() : false,
                      results = module.get.results(),
                      result = $result.data(metadata.result) || module.get.result(value, results),
                      returnedValue;
                  ;
                  if ($.isFunction(settings.onSelect)) {
                    if (settings.onSelect.call(element, result, results) === false) {
                      module.debug('Custom onSelect callback cancelled default select action');
                      return;
                    }
                  }
                  module.hideResults();
                  if (value) {
                    module.set.value(value);
                  }
                  if (href) {
                    module.verbose('Opening search link found in result', $link);
                    if (target == '_blank' || event.ctrlKey) {
                      window.open(href);
                    } else {
                      window.location.href = (href);
                    }
                  }
                }
              }
            },
            handleKeyboard: function(event) {
              var $result = $module.find(selector.result),
                  $category = $module.find(selector.category),
                  currentIndex = $result.index($result.filter('.' + className.active)),
                  resultSize = $result.length,
                  keyCode = event.which,
                  keys = {
                    backspace: 8,
                    enter: 13,
                    escape: 27,
                    upArrow: 38,
                    downArrow: 40
                  },
                  newIndex;
              ;
              if (keyCode == keys.escape) {
                module.verbose('Escape key pressed, blurring search field');
                $prompt.trigger('blur');
                ;
              }
              if (module.is.visible()) {
                if (keyCode == keys.enter) {
                  module.verbose('Enter key pressed, selecting active result');
                  if ($result.filter('.' + className.active).length > 0) {
                    module.event.result.click.call($result.filter('.' + className.active), event);
                    event.preventDefault();
                    return false;
                  }
                } else if (keyCode == keys.upArrow) {
                  module.verbose('Up key pressed, changing active result');
                  newIndex = (currentIndex - 1 < 0) ? currentIndex : currentIndex - 1;
                  ;
                  $category.removeClass(className.active);
                  ;
                  $result.removeClass(className.active).eq(newIndex).addClass(className.active).closest($category).addClass(className.active);
                  ;
                  event.preventDefault();
                } else if (keyCode == keys.downArrow) {
                  module.verbose('Down key pressed, changing active result');
                  newIndex = (currentIndex + 1 >= resultSize) ? currentIndex : currentIndex + 1;
                  ;
                  $category.removeClass(className.active);
                  ;
                  $result.removeClass(className.active).eq(newIndex).addClass(className.active).closest($category).addClass(className.active);
                  ;
                  event.preventDefault();
                }
              } else {
                if (keyCode == keys.enter) {
                  module.verbose('Enter key pressed, executing query');
                  module.query();
                  module.set.buttonPressed();
                  $prompt.one('keyup', module.remove.buttonFocus);
                }
              }
            },
            setup: {api: function() {
                var apiSettings = {
                  debug: settings.debug,
                  on: false,
                  cache: 'local',
                  action: 'search',
                  onError: module.error
                },
                    searchHTML;
                ;
                module.verbose('First request, initializing API');
                $module.api(apiSettings);
              }},
            can: {
              useAPI: function() {
                return $.fn.api !== undefined;
              },
              show: function() {
                return module.is.focused() && !module.is.visible() && !module.is.empty();
              },
              transition: function() {
                return settings.transition && $.fn.transition !== undefined && $module.transition('is supported');
              }
            },
            is: {
              empty: function() {
                return ($results.html() === '');
              },
              visible: function() {
                return ($results.filter(':visible').length > 0);
              },
              focused: function() {
                return ($prompt.filter(':focus').length > 0);
              }
            },
            get: {
              inputEvent: function() {
                var prompt = $prompt[0],
                    inputEvent = (prompt !== undefined && prompt.oninput !== undefined) ? 'input' : (prompt !== undefined && prompt.onpropertychange !== undefined) ? 'propertychange' : 'keyup';
                ;
                return inputEvent;
              },
              value: function() {
                return $prompt.val();
              },
              results: function() {
                var results = $module.data(metadata.results);
                ;
                return results;
              },
              result: function(value, results) {
                var lookupFields = ['title', 'id'],
                    result = false;
                ;
                value = (value !== undefined) ? value : module.get.value();
                ;
                results = (results !== undefined) ? results : module.get.results();
                ;
                if (settings.type === 'category') {
                  module.debug('Finding result that matches', value);
                  $.each(results, function(index, category) {
                    if ($.isArray(category.results)) {
                      result = module.search.object(value, category.results, lookupFields)[0];
                      if (result) {
                        return false;
                      }
                    }
                  });
                } else {
                  module.debug('Finding result in results object', value);
                  result = module.search.object(value, results, lookupFields)[0];
                }
                return result || false;
              }
            },
            set: {
              focus: function() {
                $module.addClass(className.focus);
              },
              loading: function() {
                $module.addClass(className.loading);
              },
              value: function(value) {
                module.verbose('Setting search input value', value);
                $prompt.val(value);
                ;
              },
              type: function(type) {
                type = type || settings.type;
                if (settings.type == 'category') {
                  $module.addClass(settings.type);
                }
              },
              buttonPressed: function() {
                $searchButton.addClass(className.pressed);
              }
            },
            remove: {
              loading: function() {
                $module.removeClass(className.loading);
              },
              focus: function() {
                $module.removeClass(className.focus);
              },
              buttonPressed: function() {
                $searchButton.removeClass(className.pressed);
              }
            },
            query: function() {
              var searchTerm = module.get.value(),
                  cache = module.read.cache(searchTerm);
              ;
              if (module.has.minimumCharacters()) {
                if (cache) {
                  module.debug('Reading result from cache', searchTerm);
                  module.save.results(cache.results);
                  module.addResults(cache.html);
                  module.inject.id(cache.results);
                } else {
                  module.debug('Querying for', searchTerm);
                  if ($.isPlainObject(settings.source) || $.isArray(settings.source)) {
                    module.search.local(searchTerm);
                  } else if (module.can.useAPI()) {
                    module.search.remote(searchTerm);
                  } else {
                    module.error(error.source);
                  }
                  settings.onSearchQuery.call(element, searchTerm);
                }
              } else {
                module.hideResults();
              }
            },
            search: {
              local: function(searchTerm) {
                var results = module.search.object(searchTerm, settings.content),
                    searchHTML;
                ;
                module.set.loading();
                module.save.results(results);
                module.debug('Returned local search results', results);
                searchHTML = module.generateResults({results: results});
                module.remove.loading();
                module.addResults(searchHTML);
                module.inject.id(results);
                module.write.cache(searchTerm, {
                  html: searchHTML,
                  results: results
                });
              },
              remote: function(searchTerm) {
                var apiSettings = {
                  onSuccess: function(response) {
                    module.parse.response.call(element, response, searchTerm);
                  },
                  onFailure: function() {
                    module.displayMessage(error.serverError);
                  },
                  urlData: {query: searchTerm}
                };
                ;
                if (!$module.api('get request')) {
                  module.setup.api();
                }
                $.extend(true, apiSettings, settings.apiSettings);
                module.debug('Executing search', apiSettings);
                module.cancel.query();
                $module.api('setting', apiSettings).api('query');
                ;
              },
              object: function(searchTerm, source, searchFields) {
                var results = [],
                    fuzzyResults = [],
                    searchExp = searchTerm.toString().replace(regExp.escape, '\\$&'),
                    matchRegExp = new RegExp(regExp.beginsWith + searchExp, 'i'),
                    addResult = function(array, result) {
                      var notResult = ($.inArray(result, results) == -1),
                          notFuzzyResult = ($.inArray(result, fuzzyResults) == -1);
                      ;
                      if (notResult && notFuzzyResult) {
                        array.push(result);
                      }
                    };
                ;
                source = source || settings.source;
                searchFields = (searchFields !== undefined) ? searchFields : settings.searchFields;
                ;
                if (!$.isArray(searchFields)) {
                  searchFields = [searchFields];
                }
                if (source === undefined || source === false) {
                  module.error(error.source);
                  return [];
                }
                $.each(searchFields, function(index, field) {
                  $.each(source, function(label, content) {
                    var fieldExists = (typeof content[field] == 'string');
                    ;
                    if (fieldExists) {
                      if (content[field].search(matchRegExp) !== -1) {
                        addResult(results, content);
                      } else if (settings.searchFullText && module.fuzzySearch(searchTerm, content[field])) {
                        addResult(fuzzyResults, content);
                      }
                    }
                  });
                });
                return $.merge(results, fuzzyResults);
              }
            },
            fuzzySearch: function(query, term) {
              var termLength = term.length,
                  queryLength = query.length;
              ;
              if (typeof query !== 'string') {
                return false;
              }
              query = query.toLowerCase();
              term = term.toLowerCase();
              if (queryLength > termLength) {
                return false;
              }
              if (queryLength === termLength) {
                return (query === term);
              }
              search: for (var characterIndex = 0,
                  nextCharacterIndex = 0; characterIndex < queryLength; characterIndex++) {
                var queryCharacter = query.charCodeAt(characterIndex);
                ;
                while (nextCharacterIndex < termLength) {
                  if (term.charCodeAt(nextCharacterIndex++) === queryCharacter) {
                    continue search;
                  }
                }
                return false;
              }
              return true;
            },
            parse: {response: function(response, searchTerm) {
                var searchHTML = module.generateResults(response);
                ;
                module.verbose('Parsing server response', response);
                if (response !== undefined) {
                  if (searchTerm !== undefined && response[fields.results] !== undefined) {
                    module.addResults(searchHTML);
                    module.inject.id(response[fields.results]);
                    module.write.cache(searchTerm, {
                      html: searchHTML,
                      results: response[fields.results]
                    });
                    module.save.results(response[fields.results]);
                  }
                }
              }},
            cancel: {query: function() {
                if (module.can.useAPI()) {
                  $module.api('abort');
                }
              }},
            has: {minimumCharacters: function() {
                var searchTerm = module.get.value(),
                    numCharacters = searchTerm.length;
                ;
                return (numCharacters >= settings.minCharacters);
              }},
            clear: {cache: function(value) {
                var cache = $module.data(metadata.cache);
                ;
                if (!value) {
                  module.debug('Clearing cache', value);
                  $module.removeData(metadata.cache);
                } else if (value && cache && cache[value]) {
                  module.debug('Removing value from cache', value);
                  delete cache[value];
                  $module.data(metadata.cache, cache);
                }
              }},
            read: {cache: function(name) {
                var cache = $module.data(metadata.cache);
                ;
                if (settings.cache) {
                  module.verbose('Checking cache for generated html for query', name);
                  return (typeof cache == 'object') && (cache[name] !== undefined) ? cache[name] : false;
                  ;
                }
                return false;
              }},
            create: {
              id: function(resultIndex, categoryIndex) {
                var resultID = (resultIndex + 1),
                    categoryID = (categoryIndex + 1),
                    firstCharCode,
                    letterID,
                    id;
                ;
                if (categoryIndex !== undefined) {
                  letterID = String.fromCharCode(97 + categoryIndex);
                  id = letterID + resultID;
                  module.verbose('Creating category result id', id);
                } else {
                  id = resultID;
                  module.verbose('Creating result id', id);
                }
                return id;
              },
              results: function() {
                if ($results.length === 0) {
                  $results = $('<div />').addClass(className.results).appendTo($module);
                  ;
                }
              }
            },
            inject: {
              result: function(result, resultIndex, categoryIndex) {
                module.verbose('Injecting result into results');
                var $selectedResult = (categoryIndex !== undefined) ? $results.children().eq(categoryIndex).children(selector.result).eq(resultIndex) : $results.children(selector.result).eq(resultIndex);
                ;
                module.verbose('Injecting results metadata', $selectedResult);
                $selectedResult.data(metadata.result, result);
                ;
              },
              id: function(results) {
                module.debug('Injecting unique ids into results');
                var categoryIndex = 0,
                    resultIndex = 0;
                ;
                if (settings.type === 'category') {
                  $.each(results, function(index, category) {
                    resultIndex = 0;
                    $.each(category.results, function(index, value) {
                      var result = category.results[index];
                      ;
                      if (result.id === undefined) {
                        result.id = module.create.id(resultIndex, categoryIndex);
                      }
                      module.inject.result(result, resultIndex, categoryIndex);
                      resultIndex++;
                    });
                    categoryIndex++;
                  });
                } else {
                  $.each(results, function(index, value) {
                    var result = results[index];
                    ;
                    if (result.id === undefined) {
                      result.id = module.create.id(resultIndex);
                    }
                    module.inject.result(result, resultIndex);
                    resultIndex++;
                  });
                }
                return results;
              }
            },
            save: {results: function(results) {
                module.verbose('Saving current search results to metadata', results);
                $module.data(metadata.results, results);
              }},
            write: {cache: function(name, value) {
                var cache = ($module.data(metadata.cache) !== undefined) ? $module.data(metadata.cache) : {};
                ;
                if (settings.cache) {
                  module.verbose('Writing generated html to cache', name, value);
                  cache[name] = value;
                  $module.data(metadata.cache, cache);
                  ;
                }
              }},
            addResults: function(html) {
              if ($.isFunction(settings.onResultsAdd)) {
                if (settings.onResultsAdd.call($results, html) === false) {
                  module.debug('onResultsAdd callback cancelled default action');
                  return false;
                }
              }
              $results.html(html);
              ;
              if (module.can.show()) {
                module.showResults();
              }
            },
            showResults: function() {
              if (!module.is.visible()) {
                if (module.can.transition()) {
                  module.debug('Showing results with css animations');
                  $results.transition({
                    animation: settings.transition + ' in',
                    debug: settings.debug,
                    verbose: settings.verbose,
                    duration: settings.duration,
                    queue: true
                  });
                  ;
                } else {
                  module.debug('Showing results with javascript');
                  $results.stop().fadeIn(settings.duration, settings.easing);
                  ;
                }
                settings.onResultsOpen.call($results);
              }
            },
            hideResults: function() {
              if (module.is.visible()) {
                if (module.can.transition()) {
                  module.debug('Hiding results with css animations');
                  $results.transition({
                    animation: settings.transition + ' out',
                    debug: settings.debug,
                    verbose: settings.verbose,
                    duration: settings.duration,
                    queue: true
                  });
                  ;
                } else {
                  module.debug('Hiding results with javascript');
                  $results.stop().fadeOut(settings.duration, settings.easing);
                  ;
                }
                settings.onResultsClose.call($results);
              }
            },
            generateResults: function(response) {
              module.debug('Generating html from response', response);
              var template = settings.templates[settings.type],
                  isProperObject = ($.isPlainObject(response[fields.results]) && !$.isEmptyObject(response[fields.results])),
                  isProperArray = ($.isArray(response[fields.results]) && response[fields.results].length > 0),
                  html = '';
              ;
              if (isProperObject || isProperArray) {
                if (settings.maxResults > 0) {
                  if (isProperObject) {
                    if (settings.type == 'standard') {
                      module.error(error.maxResults);
                    }
                  } else {
                    response[fields.results] = response[fields.results].slice(0, settings.maxResults);
                  }
                }
                if ($.isFunction(template)) {
                  html = template(response, fields);
                } else {
                  module.error(error.noTemplate, false);
                }
              } else {
                html = module.displayMessage(error.noResults, 'empty');
              }
              settings.onResults.call(element, response);
              return html;
            },
            displayMessage: function(text, type) {
              type = type || 'standard';
              module.debug('Displaying message', text, type);
              module.addResults(settings.templates.message(text, type));
              return settings.templates.message(text, type);
            },
            setting: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ($allModules.length > 1) {
                  title += ' ' + '(' + $allModules.length + ')';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.search.settings = {
        name: 'Search',
        namespace: 'search',
        debug: false,
        verbose: false,
        performance: true,
        type: 'standard',
        minCharacters: 1,
        apiSettings: false,
        source: false,
        searchFields: ['title', 'description'],
        displayField: '',
        searchFullText: true,
        automatic: true,
        hideDelay: 0,
        searchDelay: 200,
        maxResults: 7,
        cache: true,
        transition: 'scale',
        duration: 200,
        easing: 'easeOutExpo',
        onSelect: false,
        onResultsAdd: false,
        onSearchQuery: function(query) {},
        onResults: function(response) {},
        onResultsOpen: function() {},
        onResultsClose: function() {},
        className: {
          active: 'active',
          empty: 'empty',
          focus: 'focus',
          loading: 'loading',
          results: 'results',
          pressed: 'down'
        },
        error: {
          source: 'Cannot search. No source used, and Semantic API module was not included',
          noResults: 'Your search returned no results',
          logging: 'Error in debug logging, exiting.',
          noEndpoint: 'No search endpoint was specified',
          noTemplate: 'A valid template name was not specified.',
          serverError: 'There was an issue querying the server.',
          maxResults: 'Results must be an array to use maxResults setting',
          method: 'The method you called is not defined.'
        },
        metadata: {
          cache: 'cache',
          results: 'results',
          result: 'result'
        },
        regExp: {
          escape: /[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g,
          beginsWith: '(?:\s|^)'
        },
        fields: {
          categories: 'results',
          categoryName: 'name',
          categoryResults: 'results',
          description: 'description',
          image: 'image',
          price: 'price',
          results: 'results',
          title: 'title',
          action: 'action',
          actionText: 'text',
          actionURL: 'url'
        },
        selector: {
          prompt: '.prompt',
          searchButton: '.search.button',
          results: '.results',
          category: '.category',
          result: '.result',
          title: '.title, .name'
        },
        templates: {
          escape: function(string) {
            var badChars = /[&<>"'`]/g,
                shouldEscape = /[&<>"'`]/,
                escape = {
                  "&": "&amp;",
                  "<": "&lt;",
                  ">": "&gt;",
                  '"': "&quot;",
                  "'": "&#x27;",
                  "`": "&#x60;"
                },
                escapedChar = function(chr) {
                  return escape[chr];
                };
            ;
            if (shouldEscape.test(string)) {
              return string.replace(badChars, escapedChar);
            }
            return string;
          },
          message: function(message, type) {
            var html = '';
            ;
            if (message !== undefined && type !== undefined) {
              html += '' + '<div class="message ' + type + '">';
              ;
              if (type == 'empty') {
                html += '' + '<div class="header">No Results</div class="header">' + '<div class="description">' + message + '</div class="description">';
                ;
              } else {
                html += ' <div class="description">' + message + '</div>';
              }
              html += '</div>';
            }
            return html;
          },
          category: function(response, fields) {
            var html = '',
                escape = $.fn.search.settings.templates.escape;
            ;
            if (response[fields.categoryResults] !== undefined) {
              $.each(response[fields.categoryResults], function(index, category) {
                if (category[fields.results] !== undefined && category.results.length > 0) {
                  html += '<div class="category">';
                  if (category[fields.categoryName] !== undefined) {
                    html += '<div class="name">' + category[fields.categoryName] + '</div>';
                  }
                  $.each(category.results, function(index, result) {
                    if (response[fields.url]) {
                      html += '<a class="result" href="' + response[fields.url] + '">';
                    } else {
                      html += '<a class="result">';
                    }
                    if (result[fields.image] !== undefined) {
                      html += '' + '<div class="image">' + ' <img src="' + result[fields.image] + '">' + '</div>';
                      ;
                    }
                    html += '<div class="content">';
                    if (result[fields.price] !== undefined) {
                      html += '<div class="price">' + result[fields.price] + '</div>';
                    }
                    if (result[fields.title] !== undefined) {
                      html += '<div class="title">' + result[fields.title] + '</div>';
                    }
                    if (result[fields.description] !== undefined) {
                      html += '<div class="description">' + result[fields.description] + '</div>';
                    }
                    html += '' + '</div>';
                    ;
                    html += '</a>';
                  });
                  html += '' + '</div>';
                  ;
                }
              });
              if (response[fields.action]) {
                html += '' + '<a href="' + response[fields.action][fields.actionURL] + '" class="action">' + response[fields.action][fields.actionText] + '</a>';
              }
              return html;
            }
            return false;
          },
          standard: function(response, fields) {
            var html = '';
            ;
            if (response[fields.results] !== undefined) {
              $.each(response[fields.results], function(index, result) {
                if (response[fields.url]) {
                  html += '<a class="result" href="' + response[fields.url] + '">';
                } else {
                  html += '<a class="result">';
                }
                if (result[fields.image] !== undefined) {
                  html += '' + '<div class="image">' + ' <img src="' + result[fields.image] + '">' + '</div>';
                  ;
                }
                html += '<div class="content">';
                if (result[fields.price] !== undefined) {
                  html += '<div class="price">' + result[fields.price] + '</div>';
                }
                if (result[fields.title] !== undefined) {
                  html += '<div class="title">' + result[fields.title] + '</div>';
                }
                if (result[fields.description] !== undefined) {
                  html += '<div class="description">' + result[fields.description] + '</div>';
                }
                html += '' + '</div>';
                ;
                html += '</a>';
              });
              if (response[fields.action]) {
                html += '' + '<a href="' + response[fields.action][fields.actionURL] + '" class="action">' + response[fields.action][fields.actionText] + '</a>';
              }
              return html;
            }
            return false;
          }
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.shape = function(parameters) {
        var $allModules = $(this),
            $body = $('body'),
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
              setTimeout(callback, 0);
            },
            returnedValue;
        ;
        $allModules.each(function() {
          var moduleSelector = $allModules.selector || '',
              settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.shape.settings, parameters) : $.extend({}, $.fn.shape.settings),
              namespace = settings.namespace,
              selector = settings.selector,
              error = settings.error,
              className = settings.className,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $module = $(this),
              $sides = $module.find(selector.sides),
              $side = $module.find(selector.side),
              nextIndex = false,
              $activeSide,
              $nextSide,
              element = this,
              instance = $module.data(moduleNamespace),
              module;
          ;
          module = {
            initialize: function() {
              module.verbose('Initializing module for', element);
              module.set.defaultSide();
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, instance);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous module for', element);
              $module.removeData(moduleNamespace).off(eventNamespace);
              ;
            },
            refresh: function() {
              module.verbose('Refreshing selector cache for', element);
              $module = $(element);
              $sides = $(this).find(selector.shape);
              $side = $(this).find(selector.side);
            },
            repaint: function() {
              module.verbose('Forcing repaint event');
              var shape = $sides[0] || document.createElement('div'),
                  fakeAssignment = shape.offsetWidth;
              ;
            },
            animate: function(propertyObject, callback) {
              module.verbose('Animating box with properties', propertyObject);
              callback = callback || function(event) {
                module.verbose('Executing animation callback');
                if (event !== undefined) {
                  event.stopPropagation();
                }
                module.reset();
                module.set.active();
              };
              settings.beforeChange.call($nextSide[0]);
              if (module.get.transitionEvent()) {
                module.verbose('Starting CSS animation');
                $module.addClass(className.animating);
                ;
                $sides.css(propertyObject).one(module.get.transitionEvent(), callback);
                ;
                module.set.duration(settings.duration);
                requestAnimationFrame(function() {
                  $module.addClass(className.animating);
                  ;
                  $activeSide.addClass(className.hidden);
                  ;
                });
              } else {
                callback();
              }
            },
            queue: function(method) {
              module.debug('Queueing animation of', method);
              $sides.one(module.get.transitionEvent(), function() {
                module.debug('Executing queued animation');
                setTimeout(function() {
                  $module.shape(method);
                }, 0);
              });
              ;
            },
            reset: function() {
              module.verbose('Animating states reset');
              $module.removeClass(className.animating).attr('style', '').removeAttr('style');
              ;
              $sides.attr('style', '').removeAttr('style');
              ;
              $side.attr('style', '').removeAttr('style').removeClass(className.hidden);
              ;
              $nextSide.removeClass(className.animating).attr('style', '').removeAttr('style');
              ;
            },
            is: {
              complete: function() {
                return ($side.filter('.' + className.active)[0] == $nextSide[0]);
              },
              animating: function() {
                return $module.hasClass(className.animating);
              }
            },
            set: {
              defaultSide: function() {
                $activeSide = $module.find('.' + settings.className.active);
                $nextSide = ($activeSide.next(selector.side).length > 0) ? $activeSide.next(selector.side) : $module.find(selector.side).first();
                ;
                nextIndex = false;
                module.verbose('Active side set to', $activeSide);
                module.verbose('Next side set to', $nextSide);
              },
              duration: function(duration) {
                duration = duration || settings.duration;
                duration = (typeof duration == 'number') ? duration + 'ms' : duration;
                ;
                module.verbose('Setting animation duration', duration);
                if (settings.duration || settings.duration === 0) {
                  $sides.add($side).css({
                    '-webkit-transition-duration': duration,
                    '-moz-transition-duration': duration,
                    '-ms-transition-duration': duration,
                    '-o-transition-duration': duration,
                    'transition-duration': duration
                  });
                  ;
                }
              },
              currentStageSize: function() {
                var $activeSide = $module.find('.' + settings.className.active),
                    width = $activeSide.outerWidth(true),
                    height = $activeSide.outerHeight(true);
                ;
                $module.css({
                  width: width,
                  height: height
                });
                ;
              },
              stageSize: function() {
                var $clone = $module.clone().addClass(className.loading),
                    $activeSide = $clone.find('.' + settings.className.active),
                    $nextSide = (nextIndex) ? $clone.find(selector.side).eq(nextIndex) : ($activeSide.next(selector.side).length > 0) ? $activeSide.next(selector.side) : $clone.find(selector.side).first(),
                    newSize = {};
                ;
                module.set.currentStageSize();
                $activeSide.removeClass(className.active);
                $nextSide.addClass(className.active);
                $clone.insertAfter($module);
                newSize = {
                  width: $nextSide.outerWidth(true),
                  height: $nextSide.outerHeight(true)
                };
                $clone.remove();
                $module.css(newSize);
                ;
                module.verbose('Resizing stage to fit new content', newSize);
              },
              nextSide: function(selector) {
                nextIndex = selector;
                $nextSide = $side.filter(selector);
                nextIndex = $side.index($nextSide);
                if ($nextSide.length === 0) {
                  module.set.defaultSide();
                  module.error(error.side);
                }
                module.verbose('Next side manually set to', $nextSide);
              },
              active: function() {
                module.verbose('Setting new side to active', $nextSide);
                $side.removeClass(className.active);
                ;
                $nextSide.addClass(className.active);
                ;
                settings.onChange.call($nextSide[0]);
                module.set.defaultSide();
              }
            },
            flip: {
              up: function() {
                if (module.is.complete() && !module.is.animating() && !settings.allowRepeats) {
                  module.debug('Side already visible', $nextSide);
                  return;
                }
                if (!module.is.animating()) {
                  module.debug('Flipping up', $nextSide);
                  module.set.stageSize();
                  module.stage.above();
                  module.animate(module.get.transform.up());
                } else {
                  module.queue('flip up');
                }
              },
              down: function() {
                if (module.is.complete() && !module.is.animating() && !settings.allowRepeats) {
                  module.debug('Side already visible', $nextSide);
                  return;
                }
                if (!module.is.animating()) {
                  module.debug('Flipping down', $nextSide);
                  module.set.stageSize();
                  module.stage.below();
                  module.animate(module.get.transform.down());
                } else {
                  module.queue('flip down');
                }
              },
              left: function() {
                if (module.is.complete() && !module.is.animating() && !settings.allowRepeats) {
                  module.debug('Side already visible', $nextSide);
                  return;
                }
                if (!module.is.animating()) {
                  module.debug('Flipping left', $nextSide);
                  module.set.stageSize();
                  module.stage.left();
                  module.animate(module.get.transform.left());
                } else {
                  module.queue('flip left');
                }
              },
              right: function() {
                if (module.is.complete() && !module.is.animating() && !settings.allowRepeats) {
                  module.debug('Side already visible', $nextSide);
                  return;
                }
                if (!module.is.animating()) {
                  module.debug('Flipping right', $nextSide);
                  module.set.stageSize();
                  module.stage.right();
                  module.animate(module.get.transform.right());
                } else {
                  module.queue('flip right');
                }
              },
              over: function() {
                if (module.is.complete() && !module.is.animating() && !settings.allowRepeats) {
                  module.debug('Side already visible', $nextSide);
                  return;
                }
                if (!module.is.animating()) {
                  module.debug('Flipping over', $nextSide);
                  module.set.stageSize();
                  module.stage.behind();
                  module.animate(module.get.transform.over());
                } else {
                  module.queue('flip over');
                }
              },
              back: function() {
                if (module.is.complete() && !module.is.animating() && !settings.allowRepeats) {
                  module.debug('Side already visible', $nextSide);
                  return;
                }
                if (!module.is.animating()) {
                  module.debug('Flipping back', $nextSide);
                  module.set.stageSize();
                  module.stage.behind();
                  module.animate(module.get.transform.back());
                } else {
                  module.queue('flip back');
                }
              }
            },
            get: {
              transform: {
                up: function() {
                  var translate = {
                    y: -(($activeSide.outerHeight(true) - $nextSide.outerHeight(true)) / 2),
                    z: -($activeSide.outerHeight(true) / 2)
                  };
                  ;
                  return {transform: 'translateY(' + translate.y + 'px) translateZ(' + translate.z + 'px) rotateX(-90deg)'};
                },
                down: function() {
                  var translate = {
                    y: -(($activeSide.outerHeight(true) - $nextSide.outerHeight(true)) / 2),
                    z: -($activeSide.outerHeight(true) / 2)
                  };
                  ;
                  return {transform: 'translateY(' + translate.y + 'px) translateZ(' + translate.z + 'px) rotateX(90deg)'};
                },
                left: function() {
                  var translate = {
                    x: -(($activeSide.outerWidth(true) - $nextSide.outerWidth(true)) / 2),
                    z: -($activeSide.outerWidth(true) / 2)
                  };
                  ;
                  return {transform: 'translateX(' + translate.x + 'px) translateZ(' + translate.z + 'px) rotateY(90deg)'};
                },
                right: function() {
                  var translate = {
                    x: -(($activeSide.outerWidth(true) - $nextSide.outerWidth(true)) / 2),
                    z: -($activeSide.outerWidth(true) / 2)
                  };
                  ;
                  return {transform: 'translateX(' + translate.x + 'px) translateZ(' + translate.z + 'px) rotateY(-90deg)'};
                },
                over: function() {
                  var translate = {x: -(($activeSide.outerWidth(true) - $nextSide.outerWidth(true)) / 2)};
                  ;
                  return {transform: 'translateX(' + translate.x + 'px) rotateY(180deg)'};
                },
                back: function() {
                  var translate = {x: -(($activeSide.outerWidth(true) - $nextSide.outerWidth(true)) / 2)};
                  ;
                  return {transform: 'translateX(' + translate.x + 'px) rotateY(-180deg)'};
                }
              },
              transitionEvent: function() {
                var element = document.createElement('element'),
                    transitions = {
                      'transition': 'transitionend',
                      'OTransition': 'oTransitionEnd',
                      'MozTransition': 'transitionend',
                      'WebkitTransition': 'webkitTransitionEnd'
                    },
                    transition;
                ;
                for (transition in transitions) {
                  if (element.style[transition] !== undefined) {
                    return transitions[transition];
                  }
                }
              },
              nextSide: function() {
                return ($activeSide.next(selector.side).length > 0) ? $activeSide.next(selector.side) : $module.find(selector.side).first();
                ;
              }
            },
            stage: {
              above: function() {
                var box = {
                  origin: (($activeSide.outerHeight(true) - $nextSide.outerHeight(true)) / 2),
                  depth: {
                    active: ($nextSide.outerHeight(true) / 2),
                    next: ($activeSide.outerHeight(true) / 2)
                  }
                };
                ;
                module.verbose('Setting the initial animation position as above', $nextSide, box);
                $sides.css({'transform': 'translateZ(-' + box.depth.active + 'px)'});
                ;
                $activeSide.css({'transform': 'rotateY(0deg) translateZ(' + box.depth.active + 'px)'});
                ;
                $nextSide.addClass(className.animating).css({
                  'top': box.origin + 'px',
                  'transform': 'rotateX(90deg) translateZ(' + box.depth.next + 'px)'
                });
                ;
              },
              below: function() {
                var box = {
                  origin: (($activeSide.outerHeight(true) - $nextSide.outerHeight(true)) / 2),
                  depth: {
                    active: ($nextSide.outerHeight(true) / 2),
                    next: ($activeSide.outerHeight(true) / 2)
                  }
                };
                ;
                module.verbose('Setting the initial animation position as below', $nextSide, box);
                $sides.css({'transform': 'translateZ(-' + box.depth.active + 'px)'});
                ;
                $activeSide.css({'transform': 'rotateY(0deg) translateZ(' + box.depth.active + 'px)'});
                ;
                $nextSide.addClass(className.animating).css({
                  'top': box.origin + 'px',
                  'transform': 'rotateX(-90deg) translateZ(' + box.depth.next + 'px)'
                });
                ;
              },
              left: function() {
                var height = {
                  active: $activeSide.outerWidth(true),
                  next: $nextSide.outerWidth(true)
                },
                    box = {
                      origin: ((height.active - height.next) / 2),
                      depth: {
                        active: (height.next / 2),
                        next: (height.active / 2)
                      }
                    };
                ;
                module.verbose('Setting the initial animation position as left', $nextSide, box);
                $sides.css({'transform': 'translateZ(-' + box.depth.active + 'px)'});
                ;
                $activeSide.css({'transform': 'rotateY(0deg) translateZ(' + box.depth.active + 'px)'});
                ;
                $nextSide.addClass(className.animating).css({
                  'left': box.origin + 'px',
                  'transform': 'rotateY(-90deg) translateZ(' + box.depth.next + 'px)'
                });
                ;
              },
              right: function() {
                var height = {
                  active: $activeSide.outerWidth(true),
                  next: $nextSide.outerWidth(true)
                },
                    box = {
                      origin: ((height.active - height.next) / 2),
                      depth: {
                        active: (height.next / 2),
                        next: (height.active / 2)
                      }
                    };
                ;
                module.verbose('Setting the initial animation position as left', $nextSide, box);
                $sides.css({'transform': 'translateZ(-' + box.depth.active + 'px)'});
                ;
                $activeSide.css({'transform': 'rotateY(0deg) translateZ(' + box.depth.active + 'px)'});
                ;
                $nextSide.addClass(className.animating).css({
                  'left': box.origin + 'px',
                  'transform': 'rotateY(90deg) translateZ(' + box.depth.next + 'px)'
                });
                ;
              },
              behind: function() {
                var height = {
                  active: $activeSide.outerWidth(true),
                  next: $nextSide.outerWidth(true)
                },
                    box = {
                      origin: ((height.active - height.next) / 2),
                      depth: {
                        active: (height.next / 2),
                        next: (height.active / 2)
                      }
                    };
                ;
                module.verbose('Setting the initial animation position as behind', $nextSide, box);
                $activeSide.css({'transform': 'rotateY(0deg)'});
                ;
                $nextSide.addClass(className.animating).css({
                  'left': box.origin + 'px',
                  'transform': 'rotateY(-180deg)'
                });
                ;
              }
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ($allModules.length > 1) {
                  title += ' ' + '(' + $allModules.length + ')';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.shape.settings = {
        name: 'Shape',
        debug: false,
        verbose: false,
        performance: true,
        namespace: 'shape',
        beforeChange: function() {},
        onChange: function() {},
        allowRepeats: false,
        duration: false,
        error: {
          side: 'You tried to switch to a side that does not exist.',
          method: 'The method you called is not defined'
        },
        className: {
          animating: 'animating',
          hidden: 'hidden',
          loading: 'loading',
          active: 'active'
        },
        selector: {
          sides: '.sides',
          side: '.side'
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.sidebar = function(parameters) {
        var $allModules = $(this),
            $window = $(window),
            $document = $(document),
            $html = $('html'),
            $head = $('head'),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
              setTimeout(callback, 0);
            },
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.sidebar.settings, parameters) : $.extend({}, $.fn.sidebar.settings),
              selector = settings.selector,
              className = settings.className,
              namespace = settings.namespace,
              regExp = settings.regExp,
              error = settings.error,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $module = $(this),
              $context = $(settings.context),
              $sidebars = $module.children(selector.sidebar),
              $fixed = $context.children(selector.fixed),
              $pusher = $context.children(selector.pusher),
              $style,
              element = this,
              instance = $module.data(moduleNamespace),
              elementNamespace,
              id,
              currentScroll,
              transitionEvent,
              module;
          ;
          module = {
            initialize: function() {
              module.debug('Initializing sidebar', parameters);
              module.create.id();
              transitionEvent = module.get.transitionEvent();
              if (module.is.ios()) {
                module.set.ios();
              }
              if (settings.delaySetup) {
                requestAnimationFrame(module.setup.layout);
              } else {
                module.setup.layout();
              }
              requestAnimationFrame(function() {
                module.setup.cache();
              });
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            create: {id: function() {
                id = (Math.random().toString(16) + '000000000').substr(2, 8);
                elementNamespace = '.' + id;
                module.verbose('Creating unique id for element', id);
              }},
            destroy: function() {
              module.verbose('Destroying previous module for', $module);
              $module.off(eventNamespace).removeData(moduleNamespace);
              ;
              if (module.is.ios()) {
                module.remove.ios();
              }
              $context.off(elementNamespace);
              $window.off(elementNamespace);
              $document.off(elementNamespace);
            },
            event: {
              clickaway: function(event) {
                var clickedInPusher = ($pusher.find(event.target).length > 0 || $pusher.is(event.target)),
                    clickedContext = ($context.is(event.target));
                ;
                if (clickedInPusher) {
                  module.verbose('User clicked on dimmed page');
                  module.hide();
                }
                if (clickedContext) {
                  module.verbose('User clicked on dimmable context (scaled out page)');
                  module.hide();
                }
              },
              touch: function(event) {},
              containScroll: function(event) {
                if (element.scrollTop <= 0) {
                  element.scrollTop = 1;
                }
                if ((element.scrollTop + element.offsetHeight) >= element.scrollHeight) {
                  element.scrollTop = element.scrollHeight - element.offsetHeight - 1;
                }
              },
              scroll: function(event) {
                if ($(event.target).closest(selector.sidebar).length === 0) {
                  event.preventDefault();
                }
              }
            },
            bind: {
              clickaway: function() {
                module.verbose('Adding clickaway events to context', $context);
                if (settings.closable) {
                  $context.on('click' + elementNamespace, module.event.clickaway).on('touchend' + elementNamespace, module.event.clickaway);
                  ;
                }
              },
              scrollLock: function() {
                if (settings.scrollLock) {
                  module.debug('Disabling page scroll');
                  $window.on('DOMMouseScroll' + elementNamespace, module.event.scroll);
                  ;
                }
                module.verbose('Adding events to contain sidebar scroll');
                $document.on('touchmove' + elementNamespace, module.event.touch);
                ;
                $module.on('scroll' + eventNamespace, module.event.containScroll);
                ;
              }
            },
            unbind: {
              clickaway: function() {
                module.verbose('Removing clickaway events from context', $context);
                $context.off(elementNamespace);
              },
              scrollLock: function() {
                module.verbose('Removing scroll lock from page');
                $document.off(elementNamespace);
                $window.off(elementNamespace);
                $module.off('scroll' + eventNamespace);
              }
            },
            add: {inlineCSS: function() {
                var width = module.cache.width || $module.outerWidth(),
                    height = module.cache.height || $module.outerHeight(),
                    isRTL = module.is.rtl(),
                    direction = module.get.direction(),
                    distance = {
                      left: width,
                      right: -width,
                      top: height,
                      bottom: -height
                    },
                    style;
                ;
                if (isRTL) {
                  module.verbose('RTL detected, flipping widths');
                  distance.left = -width;
                  distance.right = width;
                }
                style = '<style>';
                if (direction === 'left' || direction === 'right') {
                  module.debug('Adding CSS rules for animation distance', width);
                  style += '' + ' .ui.visible.' + direction + '.sidebar ~ .fixed,' + ' .ui.visible.' + direction + '.sidebar ~ .pusher {' + '   -webkit-transform: translate3d(' + distance[direction] + 'px, 0, 0);' + '           transform: translate3d(' + distance[direction] + 'px, 0, 0);' + ' }';
                  ;
                } else if (direction === 'top' || direction == 'bottom') {
                  style += '' + ' .ui.visible.' + direction + '.sidebar ~ .fixed,' + ' .ui.visible.' + direction + '.sidebar ~ .pusher {' + '   -webkit-transform: translate3d(0, ' + distance[direction] + 'px, 0);' + '           transform: translate3d(0, ' + distance[direction] + 'px, 0);' + ' }';
                  ;
                }
                if (module.is.ie()) {
                  if (direction === 'left' || direction === 'right') {
                    module.debug('Adding CSS rules for animation distance', width);
                    style += '' + ' body.pushable > .ui.visible.' + direction + '.sidebar ~ .pusher:after {' + '   -webkit-transform: translate3d(' + distance[direction] + 'px, 0, 0);' + '           transform: translate3d(' + distance[direction] + 'px, 0, 0);' + ' }';
                    ;
                  } else if (direction === 'top' || direction == 'bottom') {
                    style += '' + ' body.pushable > .ui.visible.' + direction + '.sidebar ~ .pusher:after {' + '   -webkit-transform: translate3d(0, ' + distance[direction] + 'px, 0);' + '           transform: translate3d(0, ' + distance[direction] + 'px, 0);' + ' }';
                    ;
                  }
                  style += '' + ' body.pushable > .ui.visible.left.sidebar ~ .ui.visible.right.sidebar ~ .pusher:after,' + ' body.pushable > .ui.visible.right.sidebar ~ .ui.visible.left.sidebar ~ .pusher:after {' + '   -webkit-transform: translate3d(0px, 0, 0);' + '           transform: translate3d(0px, 0, 0);' + ' }';
                  ;
                }
                style += '</style>';
                $style = $(style).appendTo($head);
                ;
                module.debug('Adding sizing css to head', $style);
              }},
            refresh: function() {
              module.verbose('Refreshing selector cache');
              $context = $(settings.context);
              $sidebars = $context.children(selector.sidebar);
              $pusher = $context.children(selector.pusher);
              $fixed = $context.children(selector.fixed);
              module.clear.cache();
            },
            refreshSidebars: function() {
              module.verbose('Refreshing other sidebars');
              $sidebars = $context.children(selector.sidebar);
            },
            repaint: function() {
              module.verbose('Forcing repaint event');
              element.style.display = 'none';
              var ignored = element.offsetHeight;
              element.scrollTop = element.scrollTop;
              element.style.display = '';
            },
            setup: {
              cache: function() {
                module.cache = {
                  width: $module.outerWidth(),
                  height: $module.outerHeight(),
                  rtl: ($module.css('direction') == 'rtl')
                };
              },
              layout: function() {
                if ($context.children(selector.pusher).length === 0) {
                  module.debug('Adding wrapper element for sidebar');
                  module.error(error.pusher);
                  $pusher = $('<div class="pusher" />');
                  $context.children().not(selector.omitted).not($sidebars).wrapAll($pusher);
                  ;
                  module.refresh();
                }
                if ($module.nextAll(selector.pusher).length === 0 || $module.nextAll(selector.pusher)[0] !== $pusher[0]) {
                  module.debug('Moved sidebar to correct parent element');
                  module.error(error.movedSidebar, element);
                  $module.detach().prependTo($context);
                  module.refresh();
                }
                module.clear.cache();
                module.set.pushable();
                module.set.direction();
              }
            },
            attachEvents: function(selector, event) {
              var $toggle = $(selector);
              ;
              event = $.isFunction(module[event]) ? module[event] : module.toggle;
              ;
              if ($toggle.length > 0) {
                module.debug('Attaching sidebar events to element', selector, event);
                $toggle.on('click' + eventNamespace, event);
                ;
              } else {
                module.error(error.notFound, selector);
              }
            },
            show: function(callback) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              if (module.is.hidden()) {
                module.refreshSidebars();
                if (settings.overlay) {
                  module.error(error.overlay);
                  settings.transition = 'overlay';
                }
                module.refresh();
                if (module.othersActive()) {
                  module.debug('Other sidebars currently visible');
                  if (settings.exclusive) {
                    if (settings.transition != 'overlay') {
                      module.hideOthers(module.show);
                      return;
                    } else {
                      module.hideOthers();
                    }
                  } else {
                    settings.transition = 'overlay';
                  }
                }
                module.pushPage(function() {
                  callback.call(element);
                  settings.onShow.call(element);
                });
                settings.onChange.call(element);
                settings.onVisible.call(element);
              } else {
                module.debug('Sidebar is already visible');
              }
            },
            hide: function(callback) {
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              if (module.is.visible() || module.is.animating()) {
                module.debug('Hiding sidebar', callback);
                module.refreshSidebars();
                module.pullPage(function() {
                  callback.call(element);
                  settings.onHidden.call(element);
                });
                settings.onChange.call(element);
                settings.onHide.call(element);
              }
            },
            othersAnimating: function() {
              return ($sidebars.not($module).filter('.' + className.animating).length > 0);
            },
            othersVisible: function() {
              return ($sidebars.not($module).filter('.' + className.visible).length > 0);
            },
            othersActive: function() {
              return (module.othersVisible() || module.othersAnimating());
            },
            hideOthers: function(callback) {
              var $otherSidebars = $sidebars.not($module).filter('.' + className.visible),
                  sidebarCount = $otherSidebars.length,
                  callbackCount = 0;
              ;
              callback = callback || function() {};
              $otherSidebars.sidebar('hide', function() {
                callbackCount++;
                if (callbackCount == sidebarCount) {
                  callback();
                }
              });
              ;
            },
            toggle: function() {
              module.verbose('Determining toggled direction');
              if (module.is.hidden()) {
                module.show();
              } else {
                module.hide();
              }
            },
            pushPage: function(callback) {
              var transition = module.get.transition(),
                  $transition = (transition === 'overlay' || module.othersActive()) ? $module : $pusher,
                  animate,
                  dim,
                  transitionEnd;
              ;
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              if (settings.transition == 'scale down') {
                module.scrollToTop();
              }
              module.set.transition(transition);
              module.repaint();
              animate = function() {
                module.bind.clickaway();
                module.add.inlineCSS();
                module.set.animating();
                module.set.visible();
              };
              dim = function() {
                module.set.dimmed();
              };
              transitionEnd = function(event) {
                if (event.target == $transition[0]) {
                  $transition.off(transitionEvent + elementNamespace, transitionEnd);
                  module.remove.animating();
                  module.bind.scrollLock();
                  callback.call(element);
                }
              };
              $transition.off(transitionEvent + elementNamespace);
              $transition.on(transitionEvent + elementNamespace, transitionEnd);
              requestAnimationFrame(animate);
              if (settings.dimPage && !module.othersVisible()) {
                requestAnimationFrame(dim);
              }
            },
            pullPage: function(callback) {
              var transition = module.get.transition(),
                  $transition = (transition == 'overlay' || module.othersActive()) ? $module : $pusher,
                  animate,
                  transitionEnd;
              ;
              callback = $.isFunction(callback) ? callback : function() {};
              ;
              module.verbose('Removing context push state', module.get.direction());
              module.unbind.clickaway();
              module.unbind.scrollLock();
              animate = function() {
                module.set.transition(transition);
                module.set.animating();
                module.remove.visible();
                if (settings.dimPage && !module.othersVisible()) {
                  $pusher.removeClass(className.dimmed);
                }
              };
              transitionEnd = function(event) {
                if (event.target == $transition[0]) {
                  $transition.off(transitionEvent + elementNamespace, transitionEnd);
                  module.remove.animating();
                  module.remove.transition();
                  module.remove.inlineCSS();
                  if (transition == 'scale down' || (settings.returnScroll && module.is.mobile())) {
                    module.scrollBack();
                  }
                  callback.call(element);
                }
              };
              $transition.off(transitionEvent + elementNamespace);
              $transition.on(transitionEvent + elementNamespace, transitionEnd);
              requestAnimationFrame(animate);
            },
            scrollToTop: function() {
              module.verbose('Scrolling to top of page to avoid animation issues');
              currentScroll = $(window).scrollTop();
              $module.scrollTop(0);
              window.scrollTo(0, 0);
            },
            scrollBack: function() {
              module.verbose('Scrolling back to original page position');
              window.scrollTo(0, currentScroll);
            },
            clear: {cache: function() {
                module.verbose('Clearing cached dimensions');
                module.cache = {};
              }},
            set: {
              ios: function() {
                $html.addClass(className.ios);
              },
              pushed: function() {
                $context.addClass(className.pushed);
              },
              pushable: function() {
                $context.addClass(className.pushable);
              },
              dimmed: function() {
                $pusher.addClass(className.dimmed);
              },
              active: function() {
                $module.addClass(className.active);
              },
              animating: function() {
                $module.addClass(className.animating);
              },
              transition: function(transition) {
                transition = transition || module.get.transition();
                $module.addClass(transition);
              },
              direction: function(direction) {
                direction = direction || module.get.direction();
                $module.addClass(className[direction]);
              },
              visible: function() {
                $module.addClass(className.visible);
              },
              overlay: function() {
                $module.addClass(className.overlay);
              }
            },
            remove: {
              inlineCSS: function() {
                module.debug('Removing inline css styles', $style);
                if ($style && $style.length > 0) {
                  $style.remove();
                }
              },
              ios: function() {
                $html.removeClass(className.ios);
              },
              pushed: function() {
                $context.removeClass(className.pushed);
              },
              pushable: function() {
                $context.removeClass(className.pushable);
              },
              active: function() {
                $module.removeClass(className.active);
              },
              animating: function() {
                $module.removeClass(className.animating);
              },
              transition: function(transition) {
                transition = transition || module.get.transition();
                $module.removeClass(transition);
              },
              direction: function(direction) {
                direction = direction || module.get.direction();
                $module.removeClass(className[direction]);
              },
              visible: function() {
                $module.removeClass(className.visible);
              },
              overlay: function() {
                $module.removeClass(className.overlay);
              }
            },
            get: {
              direction: function() {
                if ($module.hasClass(className.top)) {
                  return className.top;
                } else if ($module.hasClass(className.right)) {
                  return className.right;
                } else if ($module.hasClass(className.bottom)) {
                  return className.bottom;
                }
                return className.left;
              },
              transition: function() {
                var direction = module.get.direction(),
                    transition;
                ;
                transition = (module.is.mobile()) ? (settings.mobileTransition == 'auto') ? settings.defaultTransition.mobile[direction] : settings.mobileTransition : (settings.transition == 'auto') ? settings.defaultTransition.computer[direction] : settings.transition;
                ;
                module.verbose('Determined transition', transition);
                return transition;
              },
              transitionEvent: function() {
                var element = document.createElement('element'),
                    transitions = {
                      'transition': 'transitionend',
                      'OTransition': 'oTransitionEnd',
                      'MozTransition': 'transitionend',
                      'WebkitTransition': 'webkitTransitionEnd'
                    },
                    transition;
                ;
                for (transition in transitions) {
                  if (element.style[transition] !== undefined) {
                    return transitions[transition];
                  }
                }
              }
            },
            is: {
              ie: function() {
                var isIE11 = (!(window.ActiveXObject) && 'ActiveXObject' in window),
                    isIE = ('ActiveXObject' in window);
                ;
                return (isIE11 || isIE);
              },
              ios: function() {
                var userAgent = navigator.userAgent,
                    isIOS = userAgent.match(regExp.ios),
                    isMobileChrome = userAgent.match(regExp.mobileChrome);
                ;
                if (isIOS && !isMobileChrome) {
                  module.verbose('Browser was found to be iOS', userAgent);
                  return true;
                } else {
                  return false;
                }
              },
              mobile: function() {
                var userAgent = navigator.userAgent,
                    isMobile = userAgent.match(regExp.mobile);
                ;
                if (isMobile) {
                  module.verbose('Browser was found to be mobile', userAgent);
                  return true;
                } else {
                  module.verbose('Browser is not mobile, using regular transition', userAgent);
                  return false;
                }
              },
              hidden: function() {
                return !module.is.visible();
              },
              visible: function() {
                return $module.hasClass(className.visible);
              },
              open: function() {
                return module.is.visible();
              },
              closed: function() {
                return module.is.hidden();
              },
              vertical: function() {
                return $module.hasClass(className.top);
              },
              animating: function() {
                return $context.hasClass(className.animating);
              },
              rtl: function() {
                if (module.cache.rtl === undefined) {
                  module.cache.rtl = ($module.css('direction') == 'rtl');
                }
                return module.cache.rtl;
              }
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          ;
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              module.invoke('destroy');
            }
            module.initialize();
          }
        });
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.sidebar.settings = {
        name: 'Sidebar',
        namespace: 'sidebar',
        debug: false,
        verbose: false,
        performance: true,
        transition: 'auto',
        mobileTransition: 'auto',
        defaultTransition: {
          computer: {
            left: 'uncover',
            right: 'uncover',
            top: 'overlay',
            bottom: 'overlay'
          },
          mobile: {
            left: 'uncover',
            right: 'uncover',
            top: 'overlay',
            bottom: 'overlay'
          }
        },
        context: 'body',
        exclusive: false,
        closable: true,
        dimPage: true,
        scrollLock: false,
        returnScroll: false,
        delaySetup: false,
        duration: 500,
        onChange: function() {},
        onShow: function() {},
        onHide: function() {},
        onHidden: function() {},
        onVisible: function() {},
        className: {
          active: 'active',
          animating: 'animating',
          dimmed: 'dimmed',
          ios: 'ios',
          pushable: 'pushable',
          pushed: 'pushed',
          right: 'right',
          top: 'top',
          left: 'left',
          bottom: 'bottom',
          visible: 'visible'
        },
        selector: {
          fixed: '.fixed',
          omitted: 'script, link, style, .ui.modal, .ui.dimmer, .ui.nag, .ui.fixed',
          pusher: '.pusher',
          sidebar: '.ui.sidebar'
        },
        regExp: {
          ios: /(iPad|iPhone|iPod)/g,
          mobileChrome: /(CriOS)/g,
          mobile: /Mobile|iP(hone|od|ad)|Android|BlackBerry|IEMobile|Kindle|NetFront|Silk-Accelerated|(hpw|web)OS|Fennec|Minimo|Opera M(obi|ini)|Blazer|Dolfin|Dolphin|Skyfire|Zune/g
        },
        error: {
          method: 'The method you called is not defined.',
          pusher: 'Had to add pusher element. For optimal performance make sure body content is inside a pusher element',
          movedSidebar: 'Had to move sidebar. For optimal performance make sure sidebar and pusher are direct children of your body tag',
          overlay: 'The overlay setting is no longer supported, use animation: overlay',
          notFound: 'There were no elements that matched the specified selector'
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.sticky = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.sticky.settings, parameters) : $.extend({}, $.fn.sticky.settings),
              className = settings.className,
              namespace = settings.namespace,
              error = settings.error,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $module = $(this),
              $window = $(window),
              $scroll = $(settings.scrollContext),
              $container,
              $context,
              selector = $module.selector || '',
              instance = $module.data(moduleNamespace),
              requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
                setTimeout(callback, 0);
              },
              element = this,
              observer,
              module;
          ;
          module = {
            initialize: function() {
              module.determineContainer();
              module.determineContext();
              module.verbose('Initializing sticky', settings, $container);
              module.save.positions();
              module.checkErrors();
              module.bind.events();
              if (settings.observeChanges) {
                module.observeChanges();
              }
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous instance');
              module.reset();
              if (observer) {
                observer.disconnect();
              }
              $window.off('load' + eventNamespace, module.event.load).off('resize' + eventNamespace, module.event.resize);
              ;
              $scroll.off('scrollchange' + eventNamespace, module.event.scrollchange);
              ;
              $module.removeData(moduleNamespace);
            },
            observeChanges: function() {
              var context = $context[0];
              ;
              if ('MutationObserver' in window) {
                observer = new MutationObserver(function(mutations) {
                  clearTimeout(module.timer);
                  module.timer = setTimeout(function() {
                    module.verbose('DOM tree modified, updating sticky menu', mutations);
                    module.refresh();
                  }, 100);
                });
                observer.observe(element, {
                  childList: true,
                  subtree: true
                });
                observer.observe(context, {
                  childList: true,
                  subtree: true
                });
                module.debug('Setting up mutation observer', observer);
              }
            },
            determineContainer: function() {
              $container = $module.offsetParent();
            },
            determineContext: function() {
              if (settings.context) {
                $context = $(settings.context);
              } else {
                $context = $container;
              }
              if ($context.length === 0) {
                module.error(error.invalidContext, settings.context, $module);
                return;
              }
            },
            checkErrors: function() {
              if (module.is.hidden()) {
                module.error(error.visible, $module);
              }
              if (module.cache.element.height > module.cache.context.height) {
                module.reset();
                module.error(error.elementSize, $module);
                return;
              }
            },
            bind: {events: function() {
                $window.on('load' + eventNamespace, module.event.load).on('resize' + eventNamespace, module.event.resize);
                ;
                $scroll.off('scroll' + eventNamespace).on('scroll' + eventNamespace, module.event.scroll).on('scrollchange' + eventNamespace, module.event.scrollchange);
                ;
              }},
            event: {
              load: function() {
                module.verbose('Page contents finished loading');
                requestAnimationFrame(module.refresh);
              },
              resize: function() {
                module.verbose('Window resized');
                requestAnimationFrame(module.refresh);
              },
              scroll: function() {
                requestAnimationFrame(function() {
                  $scroll.triggerHandler('scrollchange' + eventNamespace, $scroll.scrollTop());
                });
              },
              scrollchange: function(event, scrollPosition) {
                module.stick(scrollPosition);
                settings.onScroll.call(element);
              }
            },
            refresh: function(hardRefresh) {
              module.reset();
              if (!settings.context) {
                module.determineContext();
              }
              if (hardRefresh) {
                module.determineContainer();
              }
              module.save.positions();
              module.stick();
              settings.onReposition.call(element);
            },
            supports: {sticky: function() {
                var $element = $('<div/>'),
                    element = $element[0];
                ;
                $element.addClass(className.supported);
                return ($element.css('position').match('sticky'));
              }},
            save: {
              lastScroll: function(scroll) {
                module.lastScroll = scroll;
              },
              elementScroll: function(scroll) {
                module.elementScroll = scroll;
              },
              positions: function() {
                var window = {height: $window.height()},
                    element = {
                      margin: {
                        top: parseInt($module.css('margin-top'), 10),
                        bottom: parseInt($module.css('margin-bottom'), 10)
                      },
                      offset: $module.offset(),
                      width: $module.outerWidth(),
                      height: $module.outerHeight()
                    },
                    context = {
                      offset: $context.offset(),
                      height: $context.outerHeight()
                    },
                    container = {height: $container.outerHeight()};
                ;
                module.cache = {
                  fits: (element.height < window.height),
                  window: {height: window.height},
                  element: {
                    margin: element.margin,
                    top: element.offset.top - element.margin.top,
                    left: element.offset.left,
                    width: element.width,
                    height: element.height,
                    bottom: element.offset.top + element.height
                  },
                  context: {
                    top: context.offset.top,
                    height: context.height,
                    bottom: context.offset.top + context.height
                  }
                };
                module.set.containerSize();
                module.set.size();
                module.stick();
                module.debug('Caching element positions', module.cache);
              }
            },
            get: {
              direction: function(scroll) {
                var direction = 'down';
                ;
                scroll = scroll || $scroll.scrollTop();
                if (module.lastScroll !== undefined) {
                  if (module.lastScroll < scroll) {
                    direction = 'down';
                  } else if (module.lastScroll > scroll) {
                    direction = 'up';
                  }
                }
                return direction;
              },
              scrollChange: function(scroll) {
                scroll = scroll || $scroll.scrollTop();
                return (module.lastScroll) ? (scroll - module.lastScroll) : 0;
                ;
              },
              currentElementScroll: function() {
                if (module.elementScroll) {
                  return module.elementScroll;
                }
                return (module.is.top()) ? Math.abs(parseInt($module.css('top'), 10)) || 0 : Math.abs(parseInt($module.css('bottom'), 10)) || 0;
                ;
              },
              elementScroll: function(scroll) {
                scroll = scroll || $scroll.scrollTop();
                var element = module.cache.element,
                    window = module.cache.window,
                    delta = module.get.scrollChange(scroll),
                    maxScroll = (element.height - window.height + settings.offset),
                    elementScroll = module.get.currentElementScroll(),
                    possibleScroll = (elementScroll + delta);
                ;
                if (module.cache.fits || possibleScroll < 0) {
                  elementScroll = 0;
                } else if (possibleScroll > maxScroll) {
                  elementScroll = maxScroll;
                } else {
                  elementScroll = possibleScroll;
                }
                return elementScroll;
              }
            },
            remove: {
              lastScroll: function() {
                delete module.lastScroll;
              },
              elementScroll: function(scroll) {
                delete module.elementScroll;
              },
              offset: function() {
                $module.css('margin-top', '');
              }
            },
            set: {
              offset: function() {
                module.verbose('Setting offset on element', settings.offset);
                $module.css('margin-top', settings.offset);
                ;
              },
              containerSize: function() {
                var tagName = $container.get(0).tagName;
                ;
                if (tagName === 'HTML' || tagName == 'body') {
                  module.determineContainer();
                } else {
                  if (Math.abs($container.outerHeight() - module.cache.context.height) > settings.jitter) {
                    module.debug('Context has padding, specifying exact height for container', module.cache.context.height);
                    $container.css({height: module.cache.context.height});
                  }
                }
              },
              minimumSize: function() {
                var element = module.cache.element;
                ;
                $container.css('min-height', element.height);
                ;
              },
              scroll: function(scroll) {
                module.debug('Setting scroll on element', scroll);
                if (module.elementScroll == scroll) {
                  return;
                }
                if (module.is.top()) {
                  $module.css('bottom', '').css('top', -scroll);
                  ;
                }
                if (module.is.bottom()) {
                  $module.css('top', '').css('bottom', scroll);
                  ;
                }
              },
              size: function() {
                if (module.cache.element.height !== 0 && module.cache.element.width !== 0) {
                  element.style.setProperty('width', module.cache.element.width + 'px', 'important');
                  element.style.setProperty('height', module.cache.element.height + 'px', 'important');
                }
              }
            },
            is: {
              top: function() {
                return $module.hasClass(className.top);
              },
              bottom: function() {
                return $module.hasClass(className.bottom);
              },
              initialPosition: function() {
                return (!module.is.fixed() && !module.is.bound());
              },
              hidden: function() {
                return (!$module.is(':visible'));
              },
              bound: function() {
                return $module.hasClass(className.bound);
              },
              fixed: function() {
                return $module.hasClass(className.fixed);
              }
            },
            stick: function(scroll) {
              var cachedPosition = scroll || $scroll.scrollTop(),
                  cache = module.cache,
                  fits = cache.fits,
                  element = cache.element,
                  window = cache.window,
                  context = cache.context,
                  offset = (module.is.bottom() && settings.pushing) ? settings.bottomOffset : settings.offset,
                  scroll = {
                    top: cachedPosition + offset,
                    bottom: cachedPosition + offset + window.height
                  },
                  direction = module.get.direction(scroll.top),
                  elementScroll = (fits) ? 0 : module.get.elementScroll(scroll.top),
                  doesntFit = !fits,
                  elementVisible = (element.height !== 0);
              ;
              if (elementVisible) {
                if (module.is.initialPosition()) {
                  if (scroll.top >= context.bottom) {
                    module.debug('Initial element position is bottom of container');
                    module.bindBottom();
                  } else if (scroll.top > element.top) {
                    if ((element.height + scroll.top - elementScroll) >= context.bottom) {
                      module.debug('Initial element position is bottom of container');
                      module.bindBottom();
                    } else {
                      module.debug('Initial element position is fixed');
                      module.fixTop();
                    }
                  }
                } else if (module.is.fixed()) {
                  if (module.is.top()) {
                    if (scroll.top <= element.top) {
                      module.debug('Fixed element reached top of container');
                      module.setInitialPosition();
                    } else if ((element.height + scroll.top - elementScroll) >= context.bottom) {
                      module.debug('Fixed element reached bottom of container');
                      module.bindBottom();
                    } else if (doesntFit) {
                      module.set.scroll(elementScroll);
                      module.save.lastScroll(scroll.top);
                      module.save.elementScroll(elementScroll);
                    }
                  } else if (module.is.bottom()) {
                    if ((scroll.bottom - element.height) <= element.top) {
                      module.debug('Bottom fixed rail has reached top of container');
                      module.setInitialPosition();
                    } else if (scroll.bottom >= context.bottom) {
                      module.debug('Bottom fixed rail has reached bottom of container');
                      module.bindBottom();
                    } else if (doesntFit) {
                      module.set.scroll(elementScroll);
                      module.save.lastScroll(scroll.top);
                      module.save.elementScroll(elementScroll);
                    }
                  }
                } else if (module.is.bottom()) {
                  if (settings.pushing) {
                    if (module.is.bound() && scroll.bottom <= context.bottom) {
                      module.debug('Fixing bottom attached element to bottom of browser.');
                      module.fixBottom();
                    }
                  } else {
                    if (module.is.bound() && (scroll.top <= context.bottom - element.height)) {
                      module.debug('Fixing bottom attached element to top of browser.');
                      module.fixTop();
                    }
                  }
                }
              }
            },
            bindTop: function() {
              module.debug('Binding element to top of parent container');
              module.remove.offset();
              $module.css({
                left: '',
                top: '',
                marginBottom: ''
              }).removeClass(className.fixed).removeClass(className.bottom).addClass(className.bound).addClass(className.top);
              ;
              settings.onTop.call(element);
              settings.onUnstick.call(element);
            },
            bindBottom: function() {
              module.debug('Binding element to bottom of parent container');
              module.remove.offset();
              $module.css({
                left: '',
                top: ''
              }).removeClass(className.fixed).removeClass(className.top).addClass(className.bound).addClass(className.bottom);
              ;
              settings.onBottom.call(element);
              settings.onUnstick.call(element);
            },
            setInitialPosition: function() {
              module.debug('Returning to initial position');
              module.unfix();
              module.unbind();
            },
            fixTop: function() {
              module.debug('Fixing element to top of page');
              module.set.minimumSize();
              module.set.offset();
              $module.css({
                left: module.cache.element.left,
                bottom: '',
                marginBottom: ''
              }).removeClass(className.bound).removeClass(className.bottom).addClass(className.fixed).addClass(className.top);
              ;
              settings.onStick.call(element);
            },
            fixBottom: function() {
              module.debug('Sticking element to bottom of page');
              module.set.minimumSize();
              module.set.offset();
              $module.css({
                left: module.cache.element.left,
                bottom: '',
                marginBottom: ''
              }).removeClass(className.bound).removeClass(className.top).addClass(className.fixed).addClass(className.bottom);
              ;
              settings.onStick.call(element);
            },
            unbind: function() {
              if (module.is.bound()) {
                module.debug('Removing container bound position on element');
                module.remove.offset();
                $module.removeClass(className.bound).removeClass(className.top).removeClass(className.bottom);
                ;
              }
            },
            unfix: function() {
              if (module.is.fixed()) {
                module.debug('Removing fixed position on element');
                module.remove.offset();
                $module.removeClass(className.fixed).removeClass(className.top).removeClass(className.bottom);
                ;
                settings.onUnstick.call(element);
              }
            },
            reset: function() {
              module.debug('Reseting elements position');
              module.unbind();
              module.unfix();
              module.resetCSS();
              module.remove.offset();
              module.remove.lastScroll();
            },
            resetCSS: function() {
              $module.css({
                width: '',
                height: ''
              });
              ;
              $container.css({height: ''});
              ;
            },
            setting: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 0);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.sticky.settings = {
        name: 'Sticky',
        namespace: 'sticky',
        debug: false,
        verbose: true,
        performance: true,
        pushing: false,
        context: false,
        scrollContext: window,
        offset: 0,
        bottomOffset: 0,
        jitter: 5,
        observeChanges: false,
        onReposition: function() {},
        onScroll: function() {},
        onStick: function() {},
        onUnstick: function() {},
        onTop: function() {},
        onBottom: function() {},
        error: {
          container: 'Sticky element must be inside a relative container',
          visible: 'Element is hidden, you must call refresh after element becomes visible',
          method: 'The method you called is not defined.',
          invalidContext: 'Context specified does not exist',
          elementSize: 'Sticky element is larger than its container, cannot create sticky.'
        },
        className: {
          bound: 'bound',
          fixed: 'fixed',
          supported: 'native',
          top: 'top',
          bottom: 'bottom'
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.tab = function(parameters) {
        var $allModules = $.isFunction(this) ? $(window) : $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            initializedHistory = false,
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.tab.settings, parameters) : $.extend({}, $.fn.tab.settings),
              className = settings.className,
              metadata = settings.metadata,
              selector = settings.selector,
              error = settings.error,
              eventNamespace = '.' + settings.namespace,
              moduleNamespace = 'module-' + settings.namespace,
              $module = $(this),
              $context,
              $tabs,
              cache = {},
              firstLoad = true,
              recursionDepth = 0,
              element = this,
              instance = $module.data(moduleNamespace),
              activeTabPath,
              parameterArray,
              module,
              historyEvent;
          ;
          module = {
            initialize: function() {
              module.debug('Initializing tab menu item', $module);
              module.fix.callbacks();
              module.determineTabs();
              module.debug('Determining tabs', settings.context, $tabs);
              if (settings.auto) {
                module.set.auto();
              }
              module.bind.events();
              if (settings.history && !initializedHistory) {
                module.initializeHistory();
                initializedHistory = true;
              }
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.debug('Destroying tabs', $module);
              $module.removeData(moduleNamespace).off(eventNamespace);
              ;
            },
            bind: {events: function() {
                if (!$.isWindow(element)) {
                  module.debug('Attaching tab activation events to element', $module);
                  $module.on('click' + eventNamespace, module.event.click);
                  ;
                }
              }},
            determineTabs: function() {
              var $reference;
              ;
              if (settings.context === 'parent') {
                if ($module.closest(selector.ui).length > 0) {
                  $reference = $module.closest(selector.ui);
                  module.verbose('Using closest UI element as parent', $reference);
                } else {
                  $reference = $module;
                }
                $context = $reference.parent();
                module.verbose('Determined parent element for creating context', $context);
              } else if (settings.context) {
                $context = $(settings.context);
                module.verbose('Using selector for tab context', settings.context, $context);
              } else {
                $context = $('body');
              }
              if (settings.childrenOnly) {
                $tabs = $context.children(selector.tabs);
                module.debug('Searching tab context children for tabs', $context, $tabs);
              } else {
                $tabs = $context.find(selector.tabs);
                module.debug('Searching tab context for tabs', $context, $tabs);
              }
            },
            fix: {callbacks: function() {
                if ($.isPlainObject(parameters) && (parameters.onTabLoad || parameters.onTabInit)) {
                  if (parameters.onTabLoad) {
                    parameters.onLoad = parameters.onTabLoad;
                    delete parameters.onTabLoad;
                    module.error(error.legacyLoad, parameters.onLoad);
                  }
                  if (parameters.onTabInit) {
                    parameters.onFirstLoad = parameters.onTabInit;
                    delete parameters.onTabInit;
                    module.error(error.legacyInit, parameters.onFirstLoad);
                  }
                  settings = $.extend(true, {}, $.fn.tab.settings, parameters);
                }
              }},
            initializeHistory: function() {
              module.debug('Initializing page state');
              if ($.address === undefined) {
                module.error(error.state);
                return false;
              } else {
                if (settings.historyType == 'state') {
                  module.debug('Using HTML5 to manage state');
                  if (settings.path !== false) {
                    $.address.history(true).state(settings.path);
                    ;
                  } else {
                    module.error(error.path);
                    return false;
                  }
                }
                $.address.bind('change', module.event.history.change);
                ;
              }
            },
            event: {
              click: function(event) {
                var tabPath = $(this).data(metadata.tab);
                ;
                if (tabPath !== undefined) {
                  if (settings.history) {
                    module.verbose('Updating page state', event);
                    $.address.value(tabPath);
                  } else {
                    module.verbose('Changing tab', event);
                    module.changeTab(tabPath);
                  }
                  event.preventDefault();
                } else {
                  module.debug('No tab specified');
                }
              },
              history: {change: function(event) {
                  var tabPath = event.pathNames.join('/') || module.get.initialPath(),
                      pageTitle = settings.templates.determineTitle(tabPath) || false;
                  ;
                  module.performance.display();
                  module.debug('History change event', tabPath, event);
                  historyEvent = event;
                  if (tabPath !== undefined) {
                    module.changeTab(tabPath);
                  }
                  if (pageTitle) {
                    $.address.title(pageTitle);
                  }
                }}
            },
            refresh: function() {
              if (activeTabPath) {
                module.debug('Refreshing tab', activeTabPath);
                module.changeTab(activeTabPath);
              }
            },
            cache: {
              read: function(cacheKey) {
                return (cacheKey !== undefined) ? cache[cacheKey] : false;
                ;
              },
              add: function(cacheKey, content) {
                cacheKey = cacheKey || activeTabPath;
                module.debug('Adding cached content for', cacheKey);
                cache[cacheKey] = content;
              },
              remove: function(cacheKey) {
                cacheKey = cacheKey || activeTabPath;
                module.debug('Removing cached content for', cacheKey);
                delete cache[cacheKey];
              }
            },
            set: {
              auto: function() {
                var url = (typeof settings.path == 'string') ? settings.path.replace(/\/$/, '') + '/{$tab}' : '/{$tab}';
                ;
                module.verbose('Setting up automatic tab retrieval from server', url);
                if ($.isPlainObject(settings.apiSettings)) {
                  settings.apiSettings.url = url;
                } else {
                  settings.apiSettings = {url: url};
                }
              },
              loading: function(tabPath) {
                var $tab = module.get.tabElement(tabPath),
                    isLoading = $tab.hasClass(className.loading);
                ;
                if (!isLoading) {
                  module.verbose('Setting loading state for', $tab);
                  $tab.addClass(className.loading).siblings($tabs).removeClass(className.active + ' ' + className.loading);
                  ;
                  if ($tab.length > 0) {
                    settings.onRequest.call($tab[0], tabPath);
                  }
                }
              },
              state: function(state) {
                $.address.value(state);
              }
            },
            changeTab: function(tabPath) {
              var pushStateAvailable = (window.history && window.history.pushState),
                  shouldIgnoreLoad = (pushStateAvailable && settings.ignoreFirstLoad && firstLoad),
                  remoteContent = (settings.auto || $.isPlainObject(settings.apiSettings)),
                  pathArray = (remoteContent && !shouldIgnoreLoad) ? module.utilities.pathToArray(tabPath) : module.get.defaultPathArray(tabPath);
              ;
              tabPath = module.utilities.arrayToPath(pathArray);
              $.each(pathArray, function(index, tab) {
                var currentPathArray = pathArray.slice(0, index + 1),
                    currentPath = module.utilities.arrayToPath(currentPathArray),
                    isTab = module.is.tab(currentPath),
                    isLastIndex = (index + 1 == pathArray.length),
                    $tab = module.get.tabElement(currentPath),
                    $anchor,
                    nextPathArray,
                    nextPath,
                    isLastTab;
                ;
                module.verbose('Looking for tab', tab);
                if (isTab) {
                  module.verbose('Tab was found', tab);
                  activeTabPath = currentPath;
                  parameterArray = module.utilities.filterArray(pathArray, currentPathArray);
                  if (isLastIndex) {
                    isLastTab = true;
                  } else {
                    nextPathArray = pathArray.slice(0, index + 2);
                    nextPath = module.utilities.arrayToPath(nextPathArray);
                    isLastTab = (!module.is.tab(nextPath));
                    if (isLastTab) {
                      module.verbose('Tab parameters found', nextPathArray);
                    }
                  }
                  if (isLastTab && remoteContent) {
                    if (!shouldIgnoreLoad) {
                      module.activate.navigation(currentPath);
                      module.fetch.content(currentPath, tabPath);
                    } else {
                      module.debug('Ignoring remote content on first tab load', currentPath);
                      firstLoad = false;
                      module.cache.add(tabPath, $tab.html());
                      module.activate.all(currentPath);
                      settings.onFirstLoad.call($tab[0], currentPath, parameterArray, historyEvent);
                      settings.onLoad.call($tab[0], currentPath, parameterArray, historyEvent);
                    }
                    return false;
                  } else {
                    module.debug('Opened local tab', currentPath);
                    module.activate.all(currentPath);
                    if (!module.cache.read(currentPath)) {
                      module.cache.add(currentPath, true);
                      module.debug('First time tab loaded calling tab init');
                      settings.onFirstLoad.call($tab[0], currentPath, parameterArray, historyEvent);
                    }
                    settings.onLoad.call($tab[0], currentPath, parameterArray, historyEvent);
                  }
                } else if (tabPath.search('/') == -1 && tabPath !== '') {
                  $anchor = $('#' + tabPath + ', a[name="' + tabPath + '"]');
                  currentPath = $anchor.closest('[data-tab]').data(metadata.tab);
                  $tab = module.get.tabElement(currentPath);
                  if ($anchor && $anchor.length > 0 && currentPath) {
                    module.debug('Anchor link used, opening parent tab', $tab, $anchor);
                    if (!$tab.hasClass(className.active)) {
                      setTimeout(function() {
                        module.scrollTo($anchor);
                      }, 0);
                    }
                    module.activate.all(currentPath);
                    if (!module.cache.read(currentPath)) {
                      module.cache.add(currentPath, true);
                      module.debug('First time tab loaded calling tab init');
                      settings.onFirstLoad.call($tab[0], currentPath, parameterArray, historyEvent);
                    }
                    settings.onLoad.call($tab[0], currentPath, parameterArray, historyEvent);
                    return false;
                  }
                } else {
                  module.error(error.missingTab, $module, $context, currentPath);
                  return false;
                }
              });
            },
            scrollTo: function($element) {
              var scrollOffset = ($element && $element.length > 0) ? $element.offset().top : false;
              ;
              if (scrollOffset !== false) {
                module.debug('Forcing scroll to an in-page link in a hidden tab', scrollOffset, $element);
                $(document).scrollTop(scrollOffset);
              }
            },
            update: {content: function(tabPath, html, evaluateScripts) {
                var $tab = module.get.tabElement(tabPath),
                    tab = $tab[0];
                ;
                evaluateScripts = (evaluateScripts !== undefined) ? evaluateScripts : settings.evaluateScripts;
                ;
                if (evaluateScripts) {
                  module.debug('Updating HTML and evaluating inline scripts', tabPath, html);
                  $tab.html(html);
                } else {
                  module.debug('Updating HTML', tabPath, html);
                  tab.innerHTML = html;
                }
              }},
            fetch: {content: function(tabPath, fullTabPath) {
                var $tab = module.get.tabElement(tabPath),
                    apiSettings = {
                      dataType: 'html',
                      encodeParameters: false,
                      on: 'now',
                      cache: settings.alwaysRefresh,
                      headers: {'X-Remote': true},
                      onSuccess: function(response) {
                        module.cache.add(fullTabPath, response);
                        module.update.content(tabPath, response);
                        if (tabPath == activeTabPath) {
                          module.debug('Content loaded', tabPath);
                          module.activate.tab(tabPath);
                        } else {
                          module.debug('Content loaded in background', tabPath);
                        }
                        settings.onFirstLoad.call($tab[0], tabPath, parameterArray, historyEvent);
                        settings.onLoad.call($tab[0], tabPath, parameterArray, historyEvent);
                      },
                      urlData: {tab: fullTabPath}
                    },
                    request = $tab.api('get request') || false,
                    existingRequest = (request && request.state() === 'pending'),
                    requestSettings,
                    cachedContent;
                ;
                fullTabPath = fullTabPath || tabPath;
                cachedContent = module.cache.read(fullTabPath);
                if (settings.cache && cachedContent) {
                  module.activate.tab(tabPath);
                  module.debug('Adding cached content', fullTabPath);
                  if (settings.evaluateScripts == 'once') {
                    module.update.content(tabPath, cachedContent, false);
                  } else {
                    module.update.content(tabPath, cachedContent);
                  }
                  settings.onLoad.call($tab[0], tabPath, parameterArray, historyEvent);
                } else if (existingRequest) {
                  module.set.loading(tabPath);
                  module.debug('Content is already loading', fullTabPath);
                } else if ($.api !== undefined) {
                  requestSettings = $.extend(true, {}, settings.apiSettings, apiSettings);
                  module.debug('Retrieving remote content', fullTabPath, requestSettings);
                  module.set.loading(tabPath);
                  $tab.api(requestSettings);
                } else {
                  module.error(error.api);
                }
              }},
            activate: {
              all: function(tabPath) {
                module.activate.tab(tabPath);
                module.activate.navigation(tabPath);
              },
              tab: function(tabPath) {
                var $tab = module.get.tabElement(tabPath),
                    isActive = $tab.hasClass(className.active);
                ;
                module.verbose('Showing tab content for', $tab);
                if (!isActive) {
                  $tab.addClass(className.active).siblings($tabs).removeClass(className.active + ' ' + className.loading);
                  ;
                  if ($tab.length > 0) {
                    settings.onVisible.call($tab[0], tabPath);
                  }
                }
              },
              navigation: function(tabPath) {
                var $navigation = module.get.navElement(tabPath),
                    isActive = $navigation.hasClass(className.active);
                ;
                module.verbose('Activating tab navigation for', $navigation, tabPath);
                if (!isActive) {
                  $navigation.addClass(className.active).siblings($allModules).removeClass(className.active + ' ' + className.loading);
                  ;
                }
              }
            },
            deactivate: {
              all: function() {
                module.deactivate.navigation();
                module.deactivate.tabs();
              },
              navigation: function() {
                $allModules.removeClass(className.active);
                ;
              },
              tabs: function() {
                $tabs.removeClass(className.active + ' ' + className.loading);
                ;
              }
            },
            is: {tab: function(tabName) {
                return (tabName !== undefined) ? (module.get.tabElement(tabName).length > 0) : false;
                ;
              }},
            get: {
              initialPath: function() {
                return $allModules.eq(0).data(metadata.tab) || $tabs.eq(0).data(metadata.tab);
              },
              path: function() {
                return $.address.value();
              },
              defaultPathArray: function(tabPath) {
                return module.utilities.pathToArray(module.get.defaultPath(tabPath));
              },
              defaultPath: function(tabPath) {
                var $defaultNav = $allModules.filter('[data-' + metadata.tab + '^="' + tabPath + '/"]').eq(0),
                    defaultTab = $defaultNav.data(metadata.tab) || false;
                ;
                if (defaultTab) {
                  module.debug('Found default tab', defaultTab);
                  if (recursionDepth < settings.maxDepth) {
                    recursionDepth++;
                    return module.get.defaultPath(defaultTab);
                  }
                  module.error(error.recursion);
                } else {
                  module.debug('No default tabs found for', tabPath, $tabs);
                }
                recursionDepth = 0;
                return tabPath;
              },
              navElement: function(tabPath) {
                tabPath = tabPath || activeTabPath;
                return $allModules.filter('[data-' + metadata.tab + '="' + tabPath + '"]');
              },
              tabElement: function(tabPath) {
                var $fullPathTab,
                    $simplePathTab,
                    tabPathArray,
                    lastTab;
                ;
                tabPath = tabPath || activeTabPath;
                tabPathArray = module.utilities.pathToArray(tabPath);
                lastTab = module.utilities.last(tabPathArray);
                $fullPathTab = $tabs.filter('[data-' + metadata.tab + '="' + tabPath + '"]');
                $simplePathTab = $tabs.filter('[data-' + metadata.tab + '="' + lastTab + '"]');
                return ($fullPathTab.length > 0) ? $fullPathTab : $simplePathTab;
                ;
              },
              tab: function() {
                return activeTabPath;
              }
            },
            utilities: {
              filterArray: function(keepArray, removeArray) {
                return $.grep(keepArray, function(keepValue) {
                  return ($.inArray(keepValue, removeArray) == -1);
                });
              },
              last: function(array) {
                return $.isArray(array) ? array[array.length - 1] : false;
                ;
              },
              pathToArray: function(pathName) {
                if (pathName === undefined) {
                  pathName = activeTabPath;
                }
                return typeof pathName == 'string' ? pathName.split('/') : [pathName];
                ;
              },
              arrayToPath: function(pathArray) {
                return $.isArray(pathArray) ? pathArray.join('/') : false;
                ;
              }
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.tab = function() {
        $(window).tab.apply(this, arguments);
      };
      $.fn.tab.settings = {
        name: 'Tab',
        namespace: 'tab',
        debug: false,
        verbose: false,
        performance: true,
        auto: false,
        history: false,
        historyType: 'hash',
        path: false,
        context: false,
        childrenOnly: false,
        maxDepth: 25,
        alwaysRefresh: false,
        cache: true,
        ignoreFirstLoad: false,
        apiSettings: false,
        evaluateScripts: 'once',
        onFirstLoad: function(tabPath, parameterArray, historyEvent) {},
        onLoad: function(tabPath, parameterArray, historyEvent) {},
        onVisible: function(tabPath, parameterArray, historyEvent) {},
        onRequest: function(tabPath, parameterArray, historyEvent) {},
        templates: {determineTitle: function(tabArray) {}},
        error: {
          api: 'You attempted to load content without API module',
          method: 'The method you called is not defined',
          missingTab: 'Activated tab cannot be found. Tabs are case-sensitive.',
          noContent: 'The tab you specified is missing a content url.',
          path: 'History enabled, but no path was specified',
          recursion: 'Max recursive depth reached',
          legacyInit: 'onTabInit has been renamed to onFirstLoad in 2.0, please adjust your code.',
          legacyLoad: 'onTabLoad has been renamed to onLoad in 2.0. Please adjust your code',
          state: 'History requires Asual\'s Address library <https://github.com/asual/jquery-address>'
        },
        metadata: {
          tab: 'tab',
          loaded: 'loaded',
          promise: 'promise'
        },
        className: {
          loading: 'loading',
          active: 'active'
        },
        selector: {
          tabs: '.ui.tab',
          ui: '.ui'
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.transition = function() {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            moduleArguments = arguments,
            query = moduleArguments[0],
            queryArguments = [].slice.call(arguments, 1),
            methodInvoked = (typeof query === 'string'),
            requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
              setTimeout(callback, 0);
            },
            returnedValue;
        ;
        $allModules.each(function(index) {
          var $module = $(this),
              element = this,
              settings,
              instance,
              error,
              className,
              metadata,
              animationEnd,
              animationName,
              namespace,
              moduleNamespace,
              eventNamespace,
              module;
          ;
          module = {
            initialize: function() {
              settings = module.get.settings.apply(element, moduleArguments);
              className = settings.className;
              error = settings.error;
              metadata = settings.metadata;
              eventNamespace = '.' + settings.namespace;
              moduleNamespace = 'module-' + settings.namespace;
              instance = $module.data(moduleNamespace) || module;
              animationEnd = module.get.animationEndEvent();
              if (methodInvoked) {
                methodInvoked = module.invoke(query);
              }
              if (methodInvoked === false) {
                module.verbose('Converted arguments into settings object', settings);
                if (settings.interval) {
                  module.delay(settings.animate);
                } else {
                  module.animate();
                }
                module.instantiate();
              }
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, instance);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous module for', element);
              $module.removeData(moduleNamespace);
              ;
            },
            refresh: function() {
              module.verbose('Refreshing display type on next animation');
              delete module.displayType;
            },
            forceRepaint: function() {
              module.verbose('Forcing element repaint');
              var $parentElement = $module.parent(),
                  $nextElement = $module.next();
              ;
              if ($nextElement.length === 0) {
                $module.detach().appendTo($parentElement);
              } else {
                $module.detach().insertBefore($nextElement);
              }
            },
            repaint: function() {
              module.verbose('Repainting element');
              var fakeAssignment = element.offsetWidth;
              ;
            },
            delay: function(interval) {
              var direction = module.get.animationDirection(),
                  shouldReverse,
                  delay;
              ;
              if (!direction) {
                direction = module.can.transition() ? module.get.direction() : 'static';
                ;
              }
              interval = (interval !== undefined) ? interval : settings.interval;
              ;
              shouldReverse = (settings.reverse == 'auto' && direction == className.outward);
              delay = (shouldReverse || settings.reverse == true) ? ($allModules.length - index) * settings.interval : index * settings.interval;
              ;
              module.debug('Delaying animation by', delay);
              setTimeout(module.animate, delay);
            },
            animate: function(overrideSettings) {
              settings = overrideSettings || settings;
              if (!module.is.supported()) {
                module.error(error.support);
                return false;
              }
              module.debug('Preparing animation', settings.animation);
              if (module.is.animating()) {
                if (settings.queue) {
                  if (!settings.allowRepeats && module.has.direction() && module.is.occurring() && module.queuing !== true) {
                    module.debug('Animation is currently occurring, preventing queueing same animation', settings.animation);
                  } else {
                    module.queue(settings.animation);
                  }
                  return false;
                } else if (!settings.allowRepeats && module.is.occurring()) {
                  module.debug('Animation is already occurring, will not execute repeated animation', settings.animation);
                  return false;
                } else {
                  module.debug('New animation started, completing previous early', settings.animation);
                  instance.complete();
                }
              }
              if (module.can.animate()) {
                module.set.animating(settings.animation);
              } else {
                module.error(error.noAnimation, settings.animation, element);
              }
            },
            reset: function() {
              module.debug('Resetting animation to beginning conditions');
              module.remove.animationCallbacks();
              module.restore.conditions();
              module.remove.animating();
            },
            queue: function(animation) {
              module.debug('Queueing animation of', animation);
              module.queuing = true;
              $module.one(animationEnd + '.queue' + eventNamespace, function() {
                module.queuing = false;
                module.repaint();
                module.animate.apply(this, settings);
              });
              ;
            },
            complete: function(event) {
              module.debug('Animation complete', settings.animation);
              module.remove.completeCallback();
              module.remove.failSafe();
              if (!module.is.looping()) {
                if (module.is.outward()) {
                  module.verbose('Animation is outward, hiding element');
                  module.restore.conditions();
                  module.hide();
                } else if (module.is.inward()) {
                  module.verbose('Animation is outward, showing element');
                  module.restore.conditions();
                  module.show();
                } else {
                  module.restore.conditions();
                }
              }
            },
            force: {
              visible: function() {
                var style = $module.attr('style'),
                    userStyle = module.get.userStyle(),
                    displayType = module.get.displayType(),
                    overrideStyle = userStyle + 'display: ' + displayType + ' !important;',
                    currentDisplay = $module.css('display'),
                    emptyStyle = (style === undefined || style === '');
                ;
                if (currentDisplay !== displayType) {
                  module.verbose('Overriding default display to show element', displayType);
                  $module.attr('style', overrideStyle);
                  ;
                } else if (emptyStyle) {
                  $module.removeAttr('style');
                }
              },
              hidden: function() {
                var style = $module.attr('style'),
                    currentDisplay = $module.css('display'),
                    emptyStyle = (style === undefined || style === '');
                ;
                if (currentDisplay !== 'none' && !module.is.hidden()) {
                  module.verbose('Overriding default display to hide element');
                  $module.css('display', 'none');
                  ;
                } else if (emptyStyle) {
                  $module.removeAttr('style');
                  ;
                }
              }
            },
            has: {
              direction: function(animation) {
                var hasDirection = false;
                ;
                animation = animation || settings.animation;
                if (typeof animation === 'string') {
                  animation = animation.split(' ');
                  $.each(animation, function(index, word) {
                    if (word === className.inward || word === className.outward) {
                      hasDirection = true;
                    }
                  });
                }
                return hasDirection;
              },
              inlineDisplay: function() {
                var style = $module.attr('style') || '';
                ;
                return $.isArray(style.match(/display.*?;/, ''));
              }
            },
            set: {
              animating: function(animation) {
                var animationClass,
                    direction;
                ;
                module.remove.completeCallback();
                animation = animation || settings.animation;
                animationClass = module.get.animationClass(animation);
                module.save.animation(animationClass);
                module.force.visible();
                module.remove.hidden();
                module.remove.direction();
                module.start.animation(animationClass);
              },
              duration: function(animationName, duration) {
                duration = duration || settings.duration;
                duration = (typeof duration == 'number') ? duration + 'ms' : duration;
                ;
                if (duration || duration === 0) {
                  module.verbose('Setting animation duration', duration);
                  $module.css({'animation-duration': duration});
                  ;
                }
              },
              direction: function(direction) {
                direction = direction || module.get.direction();
                if (direction == className.inward) {
                  module.set.inward();
                } else {
                  module.set.outward();
                }
              },
              looping: function() {
                module.debug('Transition set to loop');
                $module.addClass(className.looping);
                ;
              },
              hidden: function() {
                $module.addClass(className.transition).addClass(className.hidden);
                ;
              },
              inward: function() {
                module.debug('Setting direction to inward');
                $module.removeClass(className.outward).addClass(className.inward);
                ;
              },
              outward: function() {
                module.debug('Setting direction to outward');
                $module.removeClass(className.inward).addClass(className.outward);
                ;
              },
              visible: function() {
                $module.addClass(className.transition).addClass(className.visible);
                ;
              }
            },
            start: {animation: function(animationClass) {
                animationClass = animationClass || module.get.animationClass();
                module.debug('Starting tween', animationClass);
                $module.addClass(animationClass).one(animationEnd + '.complete' + eventNamespace, module.complete);
                ;
                if (settings.useFailSafe) {
                  module.add.failSafe();
                }
                module.set.duration(settings.duration);
                settings.onStart.call(element);
              }},
            save: {
              animation: function(animation) {
                if (!module.cache) {
                  module.cache = {};
                }
                module.cache.animation = animation;
              },
              displayType: function(displayType) {
                if (displayType !== 'none') {
                  $module.data(metadata.displayType, displayType);
                }
              },
              transitionExists: function(animation, exists) {
                $.fn.transition.exists[animation] = exists;
                module.verbose('Saving existence of transition', animation, exists);
              }
            },
            restore: {conditions: function() {
                var animation = module.get.currentAnimation();
                ;
                if (animation) {
                  $module.removeClass(animation);
                  ;
                  module.verbose('Removing animation class', module.cache);
                }
                module.remove.duration();
              }},
            add: {failSafe: function() {
                var duration = module.get.duration();
                ;
                module.timer = setTimeout(function() {
                  $module.triggerHandler(animationEnd);
                }, duration + settings.failSafeDelay);
                module.verbose('Adding fail safe timer', module.timer);
              }},
            remove: {
              animating: function() {
                $module.removeClass(className.animating);
              },
              animationCallbacks: function() {
                module.remove.queueCallback();
                module.remove.completeCallback();
              },
              queueCallback: function() {
                $module.off('.queue' + eventNamespace);
              },
              completeCallback: function() {
                $module.off('.complete' + eventNamespace);
              },
              display: function() {
                $module.css('display', '');
              },
              direction: function() {
                $module.removeClass(className.inward).removeClass(className.outward);
                ;
              },
              duration: function() {
                $module.css('animation-duration', '');
                ;
              },
              failSafe: function() {
                module.verbose('Removing fail safe timer', module.timer);
                if (module.timer) {
                  clearTimeout(module.timer);
                }
              },
              hidden: function() {
                $module.removeClass(className.hidden);
              },
              visible: function() {
                $module.removeClass(className.visible);
              },
              looping: function() {
                module.debug('Transitions are no longer looping');
                if (module.is.looping()) {
                  module.reset();
                  $module.removeClass(className.looping);
                  ;
                }
              },
              transition: function() {
                $module.removeClass(className.visible).removeClass(className.hidden);
                ;
              }
            },
            get: {
              settings: function(animation, duration, onComplete) {
                if (typeof animation == 'object') {
                  return $.extend(true, {}, $.fn.transition.settings, animation);
                } else if (typeof onComplete == 'function') {
                  return $.extend({}, $.fn.transition.settings, {
                    animation: animation,
                    onComplete: onComplete,
                    duration: duration
                  });
                } else if (typeof duration == 'string' || typeof duration == 'number') {
                  return $.extend({}, $.fn.transition.settings, {
                    animation: animation,
                    duration: duration
                  });
                } else if (typeof duration == 'object') {
                  return $.extend({}, $.fn.transition.settings, duration, {animation: animation});
                } else if (typeof duration == 'function') {
                  return $.extend({}, $.fn.transition.settings, {
                    animation: animation,
                    onComplete: duration
                  });
                } else {
                  return $.extend({}, $.fn.transition.settings, {animation: animation});
                }
                return $.fn.transition.settings;
              },
              animationClass: function(animation) {
                var animationClass = animation || settings.animation,
                    directionClass = (module.can.transition() && !module.has.direction()) ? module.get.direction() + ' ' : '';
                ;
                return className.animating + ' ' + className.transition + ' ' + directionClass + animationClass;
                ;
              },
              currentAnimation: function() {
                return (module.cache && module.cache.animation !== undefined) ? module.cache.animation : false;
                ;
              },
              currentDirection: function() {
                return module.is.inward() ? className.inward : className.outward;
                ;
              },
              direction: function() {
                return module.is.hidden() || !module.is.visible() ? className.inward : className.outward;
                ;
              },
              animationDirection: function(animation) {
                var direction;
                ;
                animation = animation || settings.animation;
                if (typeof animation === 'string') {
                  animation = animation.split(' ');
                  $.each(animation, function(index, word) {
                    if (word === className.inward) {
                      direction = className.inward;
                    } else if (word === className.outward) {
                      direction = className.outward;
                    }
                  });
                }
                if (direction) {
                  return direction;
                }
                return false;
              },
              duration: function(duration) {
                duration = duration || settings.duration;
                if (duration === false) {
                  duration = $module.css('animation-duration') || 0;
                }
                return (typeof duration === 'string') ? (duration.indexOf('ms') > -1) ? parseFloat(duration) : parseFloat(duration) * 1000 : duration;
                ;
              },
              displayType: function() {
                if (settings.displayType) {
                  return settings.displayType;
                }
                if ($module.data(metadata.displayType) === undefined) {
                  module.can.transition(true);
                }
                return $module.data(metadata.displayType);
              },
              userStyle: function(style) {
                style = style || $module.attr('style') || '';
                return style.replace(/display.*?;/, '');
              },
              transitionExists: function(animation) {
                return $.fn.transition.exists[animation];
              },
              animationStartEvent: function() {
                var element = document.createElement('div'),
                    animations = {
                      'animation': 'animationstart',
                      'OAnimation': 'oAnimationStart',
                      'MozAnimation': 'mozAnimationStart',
                      'WebkitAnimation': 'webkitAnimationStart'
                    },
                    animation;
                ;
                for (animation in animations) {
                  if (element.style[animation] !== undefined) {
                    return animations[animation];
                  }
                }
                return false;
              },
              animationEndEvent: function() {
                var element = document.createElement('div'),
                    animations = {
                      'animation': 'animationend',
                      'OAnimation': 'oAnimationEnd',
                      'MozAnimation': 'mozAnimationEnd',
                      'WebkitAnimation': 'webkitAnimationEnd'
                    },
                    animation;
                ;
                for (animation in animations) {
                  if (element.style[animation] !== undefined) {
                    return animations[animation];
                  }
                }
                return false;
              }
            },
            can: {
              transition: function(forced) {
                var animation = settings.animation,
                    transitionExists = module.get.transitionExists(animation),
                    elementClass,
                    tagName,
                    $clone,
                    currentAnimation,
                    inAnimation,
                    directionExists,
                    displayType;
                ;
                if (transitionExists === undefined || forced) {
                  module.verbose('Determining whether animation exists');
                  elementClass = $module.attr('class');
                  tagName = $module.prop('tagName');
                  $clone = $('<' + tagName + ' />').addClass(elementClass).insertAfter($module);
                  currentAnimation = $clone.addClass(animation).removeClass(className.inward).removeClass(className.outward).addClass(className.animating).addClass(className.transition).css('animationName');
                  ;
                  inAnimation = $clone.addClass(className.inward).css('animationName');
                  ;
                  displayType = $clone.attr('class', elementClass).removeAttr('style').removeClass(className.hidden).removeClass(className.visible).show().css('display');
                  ;
                  module.verbose('Determining final display state', displayType);
                  module.save.displayType(displayType);
                  $clone.remove();
                  if (currentAnimation != inAnimation) {
                    module.debug('Direction exists for animation', animation);
                    directionExists = true;
                  } else if (currentAnimation == 'none' || !currentAnimation) {
                    module.debug('No animation defined in css', animation);
                    return;
                  } else {
                    module.debug('Static animation found', animation, displayType);
                    directionExists = false;
                  }
                  module.save.transitionExists(animation, directionExists);
                }
                return (transitionExists !== undefined) ? transitionExists : directionExists;
                ;
              },
              animate: function() {
                return (module.can.transition() !== undefined);
              }
            },
            is: {
              animating: function() {
                return $module.hasClass(className.animating);
              },
              inward: function() {
                return $module.hasClass(className.inward);
              },
              outward: function() {
                return $module.hasClass(className.outward);
              },
              looping: function() {
                return $module.hasClass(className.looping);
              },
              occurring: function(animation) {
                animation = animation || settings.animation;
                animation = '.' + animation.replace(' ', '.');
                return ($module.filter(animation).length > 0);
              },
              visible: function() {
                return $module.is(':visible');
              },
              hidden: function() {
                return $module.css('visibility') === 'hidden';
              },
              supported: function() {
                return (animationEnd !== false);
              }
            },
            hide: function() {
              module.verbose('Hiding element');
              if (module.is.animating()) {
                module.reset();
              }
              element.blur();
              module.remove.display();
              module.remove.visible();
              module.set.hidden();
              module.force.hidden();
              settings.onHide.call(element);
              settings.onComplete.call(element);
            },
            show: function(display) {
              module.verbose('Showing element', display);
              module.remove.hidden();
              module.set.visible();
              module.force.visible();
              settings.onShow.call(element);
              settings.onComplete.call(element);
            },
            toggle: function() {
              if (module.is.visible()) {
                module.hide();
              } else {
                module.show();
              }
            },
            stop: function() {
              module.debug('Stopping current animation');
              $module.triggerHandler(animationEnd);
            },
            stopAll: function() {
              module.debug('Stopping all animation');
              module.remove.queueCallback();
              $module.triggerHandler(animationEnd);
            },
            clear: {queue: function() {
                module.debug('Clearing animation queue');
                module.remove.queueCallback();
              }},
            enable: function() {
              module.verbose('Starting animation');
              $module.removeClass(className.disabled);
            },
            disable: function() {
              module.debug('Stopping animation');
              $module.addClass(className.disabled);
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ($allModules.length > 1) {
                  title += ' ' + '(' + $allModules.length + ')';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return (found !== undefined) ? found : false;
              ;
            }
          };
          module.initialize();
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.transition.exists = {};
      $.fn.transition.settings = {
        name: 'Transition',
        debug: false,
        verbose: false,
        performance: true,
        namespace: 'transition',
        interval: 0,
        reverse: 'auto',
        onStart: function() {},
        onComplete: function() {},
        onShow: function() {},
        onHide: function() {},
        useFailSafe: true,
        failSafeDelay: 100,
        allowRepeats: false,
        displayType: false,
        animation: 'fade',
        duration: false,
        queue: true,
        metadata: {displayType: 'display'},
        className: {
          animating: 'animating',
          disabled: 'disabled',
          hidden: 'hidden',
          inward: 'in',
          loading: 'loading',
          looping: 'looping',
          outward: 'out',
          transition: 'transition',
          visible: 'visible'
        },
        error: {
          noAnimation: 'There is no css animation matching the one you specified. Please make sure your css is vendor prefixed, and you have included transition css.',
          repeated: 'That animation is already occurring, cancelling repeated animation',
          method: 'The method you called is not defined',
          support: 'This browser does not support CSS animations'
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.api = $.fn.api = function(parameters) {
        var $allModules = $.isFunction(this) ? $(window) : $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.api.settings, parameters) : $.extend({}, $.fn.api.settings),
              namespace = settings.namespace,
              metadata = settings.metadata,
              selector = settings.selector,
              error = settings.error,
              className = settings.className,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $module = $(this),
              $form = $module.closest(selector.form),
              $context = (settings.stateContext) ? $(settings.stateContext) : $module,
              ajaxSettings,
              requestSettings,
              url,
              data,
              requestStartTime,
              element = this,
              context = $context[0],
              instance = $module.data(moduleNamespace),
              module;
          ;
          module = {
            initialize: function() {
              if (!methodInvoked) {
                module.bind.events();
              }
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, instance);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous module for', element);
              $module.removeData(moduleNamespace).off(eventNamespace);
              ;
            },
            bind: {events: function() {
                var triggerEvent = module.get.event();
                ;
                if (triggerEvent) {
                  module.verbose('Attaching API events to element', triggerEvent);
                  $module.on(triggerEvent + eventNamespace, module.event.trigger);
                  ;
                } else if (settings.on == 'now') {
                  module.debug('Querying API endpoint immediately');
                  module.query();
                }
              }},
            decode: {json: function(response) {
                if (response !== undefined && typeof response == 'string') {
                  try {
                    response = JSON.parse(response);
                  } catch (e) {}
                }
                return response;
              }},
            read: {cachedResponse: function(url) {
                var response;
                ;
                if (window.Storage === undefined) {
                  module.error(error.noStorage);
                  return;
                }
                response = sessionStorage.getItem(url);
                module.debug('Using cached response', url, response);
                response = module.decode.json(response);
                return false;
              }},
            write: {cachedResponse: function(url, response) {
                if (response && response === '') {
                  module.debug('Response empty, not caching', response);
                  return;
                }
                if (window.Storage === undefined) {
                  module.error(error.noStorage);
                  return;
                }
                if ($.isPlainObject(response)) {
                  response = JSON.stringify(response);
                }
                sessionStorage.setItem(url, response);
                module.verbose('Storing cached response for url', url, response);
              }},
            query: function() {
              if (module.is.disabled()) {
                module.debug('Element is disabled API request aborted');
                return;
              }
              if (module.is.loading()) {
                if (settings.interruptRequests) {
                  module.debug('Interrupting previous request');
                  module.abort();
                } else {
                  module.debug('Cancelling request, previous request is still pending');
                  return;
                }
              }
              if (settings.defaultData) {
                $.extend(true, settings.urlData, module.get.defaultData());
              }
              if (settings.serializeForm) {
                settings.data = module.add.formData(settings.data);
              }
              requestSettings = module.get.settings();
              if (requestSettings === false) {
                module.cancelled = true;
                module.error(error.beforeSend);
                return;
              } else {
                module.cancelled = false;
              }
              url = module.get.templatedURL();
              if (!url && !module.is.mocked()) {
                module.error(error.missingURL);
                return;
              }
              url = module.add.urlData(url);
              if (!url && !module.is.mocked()) {
                return;
              }
              ajaxSettings = $.extend(true, {}, settings, {
                type: settings.method || settings.type,
                data: data,
                url: settings.base + url,
                beforeSend: settings.beforeXHR,
                success: function() {},
                failure: function() {},
                complete: function() {}
              });
              module.debug('Querying URL', ajaxSettings.url);
              module.verbose('Using AJAX settings', ajaxSettings);
              if (settings.cache === 'local' && module.read.cachedResponse(url)) {
                module.debug('Response returned from local cache');
                module.request = module.create.request();
                module.request.resolveWith(context, [module.read.cachedResponse(url)]);
                return;
              }
              if (!settings.throttle) {
                module.debug('Sending request', data, ajaxSettings.method);
                module.send.request();
              } else {
                if (!settings.throttleFirstRequest && !module.timer) {
                  module.debug('Sending request', data, ajaxSettings.method);
                  module.send.request();
                  module.timer = setTimeout(function() {}, settings.throttle);
                } else {
                  module.debug('Throttling request', settings.throttle);
                  clearTimeout(module.timer);
                  module.timer = setTimeout(function() {
                    if (module.timer) {
                      delete module.timer;
                    }
                    module.debug('Sending throttled request', data, ajaxSettings.method);
                    module.send.request();
                  }, settings.throttle);
                }
              }
            },
            should: {removeError: function() {
                return (settings.hideError === true || (settings.hideError === 'auto' && !module.is.form()));
              }},
            is: {
              disabled: function() {
                return ($module.filter(selector.disabled).length > 0);
              },
              form: function() {
                return $module.is('form') || $context.is('form');
              },
              mocked: function() {
                return (settings.mockResponse || settings.mockResponseAsync);
              },
              input: function() {
                return $module.is('input');
              },
              loading: function() {
                return (module.request && module.request.state() == 'pending');
              },
              abortedRequest: function(xhr) {
                if (xhr && xhr.readyState !== undefined && xhr.readyState === 0) {
                  module.verbose('XHR request determined to be aborted');
                  return true;
                } else {
                  module.verbose('XHR request was not aborted');
                  return false;
                }
              },
              validResponse: function(response) {
                if ((settings.dataType !== 'json' && settings.dataType !== 'jsonp') || !$.isFunction(settings.successTest)) {
                  module.verbose('Response is not JSON, skipping validation', settings.successTest, response);
                  return true;
                }
                module.debug('Checking JSON returned success', settings.successTest, response);
                if (settings.successTest(response)) {
                  module.debug('Response passed success test', response);
                  return true;
                } else {
                  module.debug('Response failed success test', response);
                  return false;
                }
              }
            },
            was: {
              cancelled: function() {
                return (module.cancelled || false);
              },
              succesful: function() {
                return (module.request && module.request.state() == 'resolved');
              },
              failure: function() {
                return (module.request && module.request.state() == 'rejected');
              },
              complete: function() {
                return (module.request && (module.request.state() == 'resolved' || module.request.state() == 'rejected'));
              }
            },
            add: {
              urlData: function(url, urlData) {
                var requiredVariables,
                    optionalVariables;
                ;
                if (url) {
                  requiredVariables = url.match(settings.regExp.required);
                  optionalVariables = url.match(settings.regExp.optional);
                  urlData = urlData || settings.urlData;
                  if (requiredVariables) {
                    module.debug('Looking for required URL variables', requiredVariables);
                    $.each(requiredVariables, function(index, templatedString) {
                      var variable = (templatedString.indexOf('$') !== -1) ? templatedString.substr(2, templatedString.length - 3) : templatedString.substr(1, templatedString.length - 2),
                          value = ($.isPlainObject(urlData) && urlData[variable] !== undefined) ? urlData[variable] : ($module.data(variable) !== undefined) ? $module.data(variable) : ($context.data(variable) !== undefined) ? $context.data(variable) : urlData[variable];
                      ;
                      if (value === undefined) {
                        module.error(error.requiredParameter, variable, url);
                        url = false;
                        return false;
                      } else {
                        module.verbose('Found required variable', variable, value);
                        value = (settings.encodeParameters) ? module.get.urlEncodedValue(value) : value;
                        ;
                        url = url.replace(templatedString, value);
                      }
                    });
                  }
                  if (optionalVariables) {
                    module.debug('Looking for optional URL variables', requiredVariables);
                    $.each(optionalVariables, function(index, templatedString) {
                      var variable = (templatedString.indexOf('$') !== -1) ? templatedString.substr(3, templatedString.length - 4) : templatedString.substr(2, templatedString.length - 3),
                          value = ($.isPlainObject(urlData) && urlData[variable] !== undefined) ? urlData[variable] : ($module.data(variable) !== undefined) ? $module.data(variable) : ($context.data(variable) !== undefined) ? $context.data(variable) : urlData[variable];
                      ;
                      if (value !== undefined) {
                        module.verbose('Optional variable Found', variable, value);
                        url = url.replace(templatedString, value);
                      } else {
                        module.verbose('Optional variable not found', variable);
                        if (url.indexOf('/' + templatedString) !== -1) {
                          url = url.replace('/' + templatedString, '');
                        } else {
                          url = url.replace(templatedString, '');
                        }
                      }
                    });
                  }
                }
                return url;
              },
              formData: function(data) {
                var canSerialize = ($.fn.serializeObject !== undefined),
                    formData = (canSerialize) ? $form.serializeObject() : $form.serialize(),
                    hasOtherData;
                ;
                data = data || settings.data;
                hasOtherData = $.isPlainObject(data);
                if (hasOtherData) {
                  if (canSerialize) {
                    module.debug('Extending existing data with form data', data, formData);
                    data = $.extend(true, {}, data, formData);
                  } else {
                    module.error(error.missingSerialize);
                    module.debug('Cant extend data. Replacing data with form data', data, formData);
                    data = formData;
                  }
                } else {
                  module.debug('Adding form data', formData);
                  data = formData;
                }
                return data;
              }
            },
            send: {request: function() {
                module.set.loading();
                module.request = module.create.request();
                if (module.is.mocked()) {
                  module.mockedXHR = module.create.mockedXHR();
                } else {
                  module.xhr = module.create.xhr();
                }
                settings.onRequest.call(context, module.request, module.xhr);
              }},
            event: {
              trigger: function(event) {
                module.query();
                if (event.type == 'submit' || event.type == 'click') {
                  event.preventDefault();
                }
              },
              xhr: {
                always: function() {},
                done: function(response, textStatus, xhr) {
                  var context = this,
                      elapsedTime = (new Date().getTime() - requestStartTime),
                      timeLeft = (settings.loadingDuration - elapsedTime),
                      translatedResponse = ($.isFunction(settings.onResponse)) ? settings.onResponse.call(context, $.extend(true, {}, response)) : false;
                  ;
                  timeLeft = (timeLeft > 0) ? timeLeft : 0;
                  ;
                  if (translatedResponse) {
                    module.debug('Modified API response in onResponse callback', settings.onResponse, translatedResponse, response);
                    response = translatedResponse;
                  }
                  if (timeLeft > 0) {
                    module.debug('Response completed early delaying state change by', timeLeft);
                  }
                  setTimeout(function() {
                    if (module.is.validResponse(response)) {
                      module.request.resolveWith(context, [response, xhr]);
                    } else {
                      module.request.rejectWith(context, [xhr, 'invalid']);
                    }
                  }, timeLeft);
                },
                fail: function(xhr, status, httpMessage) {
                  var context = this,
                      elapsedTime = (new Date().getTime() - requestStartTime),
                      timeLeft = (settings.loadingDuration - elapsedTime);
                  ;
                  timeLeft = (timeLeft > 0) ? timeLeft : 0;
                  ;
                  if (timeLeft > 0) {
                    module.debug('Response completed early delaying state change by', timeLeft);
                  }
                  setTimeout(function() {
                    if (module.is.abortedRequest(xhr)) {
                      module.request.rejectWith(context, [xhr, 'aborted', httpMessage]);
                    } else {
                      module.request.rejectWith(context, [xhr, 'error', status, httpMessage]);
                    }
                  }, timeLeft);
                }
              },
              request: {
                done: function(response, xhr) {
                  module.debug('Successful API Response', response);
                  if (settings.cache === 'local' && url) {
                    module.write.cachedResponse(url, response);
                    module.debug('Saving server response locally', module.cache);
                  }
                  settings.onSuccess.call(context, response, $module, xhr);
                },
                complete: function(firstParameter, secondParameter) {
                  var xhr,
                      response;
                  ;
                  if (module.was.succesful()) {
                    response = firstParameter;
                    xhr = secondParameter;
                  } else {
                    xhr = firstParameter;
                    response = module.get.responseFromXHR(xhr);
                  }
                  module.remove.loading();
                  settings.onComplete.call(context, response, $module, xhr);
                },
                fail: function(xhr, status, httpMessage) {
                  var response = module.get.responseFromXHR(xhr),
                      errorMessage = module.get.errorFromRequest(response, status, httpMessage);
                  ;
                  if (status == 'aborted') {
                    module.debug('XHR Aborted (Most likely caused by page navigation or CORS Policy)', status, httpMessage);
                    settings.onAbort.call(context, status, $module, xhr);
                  } else if (status == 'invalid') {
                    module.debug('JSON did not pass success test. A server-side error has most likely occurred', response);
                  } else if (status == 'error') {
                    if (xhr !== undefined) {
                      module.debug('XHR produced a server error', status, httpMessage);
                      if (xhr.status != 200 && httpMessage !== undefined && httpMessage !== '') {
                        module.error(error.statusMessage + httpMessage, ajaxSettings.url);
                      }
                      settings.onError.call(context, errorMessage, $module, xhr);
                    }
                  }
                  if (settings.errorDuration && status !== 'aborted') {
                    module.debug('Adding error state');
                    module.set.error();
                    if (module.should.removeError()) {
                      setTimeout(module.remove.error, settings.errorDuration);
                    }
                  }
                  module.debug('API Request failed', errorMessage, xhr);
                  settings.onFailure.call(context, response, $module, xhr);
                }
              }
            },
            create: {
              request: function() {
                return $.Deferred().always(module.event.request.complete).done(module.event.request.done).fail(module.event.request.fail);
                ;
              },
              mockedXHR: function() {
                var textStatus = false,
                    status = false,
                    httpMessage = false,
                    asyncCallback,
                    response,
                    mockedXHR;
                ;
                mockedXHR = $.Deferred().always(module.event.xhr.complete).done(module.event.xhr.done).fail(module.event.xhr.fail);
                ;
                if (settings.mockResponse) {
                  if ($.isFunction(settings.mockResponse)) {
                    module.debug('Using mocked callback returning response', settings.mockResponse);
                    response = settings.mockResponse.call(context, settings);
                  } else {
                    module.debug('Using specified response', settings.mockResponse);
                    response = settings.mockResponse;
                  }
                  mockedXHR.resolveWith(context, [response, textStatus, {responseText: response}]);
                } else if ($.isFunction(settings.mockResponseAsync)) {
                  asyncCallback = function(response) {
                    module.debug('Async callback returned response', response);
                    if (response) {
                      mockedXHR.resolveWith(context, [response, textStatus, {responseText: response}]);
                    } else {
                      mockedXHR.rejectWith(context, [{responseText: response}, status, httpMessage]);
                    }
                  };
                  module.debug('Using async mocked response', settings.mockResponseAsync);
                  settings.mockResponseAsync.call(context, settings, asyncCallback);
                }
                return mockedXHR;
              },
              xhr: function() {
                var xhr;
                ;
                xhr = $.ajax(ajaxSettings).always(module.event.xhr.always).done(module.event.xhr.done).fail(module.event.xhr.fail);
                ;
                module.verbose('Created server request', xhr);
                return xhr;
              }
            },
            set: {
              error: function() {
                module.verbose('Adding error state to element', $context);
                $context.addClass(className.error);
              },
              loading: function() {
                module.verbose('Adding loading state to element', $context);
                $context.addClass(className.loading);
                requestStartTime = new Date().getTime();
              }
            },
            remove: {
              error: function() {
                module.verbose('Removing error state from element', $context);
                $context.removeClass(className.error);
              },
              loading: function() {
                module.verbose('Removing loading state from element', $context);
                $context.removeClass(className.loading);
              }
            },
            get: {
              responseFromXHR: function(xhr) {
                return $.isPlainObject(xhr) ? (settings.dataType == 'json' || settings.dataType == 'jsonp') ? module.decode.json(xhr.responseText) : xhr.responseText : false;
                ;
              },
              errorFromRequest: function(response, status, httpMessage) {
                return ($.isPlainObject(response) && response.error !== undefined) ? response.error : (settings.error[status] !== undefined) ? settings.error[status] : httpMessage;
                ;
              },
              request: function() {
                return module.request || false;
              },
              xhr: function() {
                return module.xhr || false;
              },
              settings: function() {
                var runSettings;
                ;
                runSettings = settings.beforeSend.call(context, settings);
                if (runSettings) {
                  if (runSettings.success !== undefined) {
                    module.debug('Legacy success callback detected', runSettings);
                    module.error(error.legacyParameters, runSettings.success);
                    runSettings.onSuccess = runSettings.success;
                  }
                  if (runSettings.failure !== undefined) {
                    module.debug('Legacy failure callback detected', runSettings);
                    module.error(error.legacyParameters, runSettings.failure);
                    runSettings.onFailure = runSettings.failure;
                  }
                  if (runSettings.complete !== undefined) {
                    module.debug('Legacy complete callback detected', runSettings);
                    module.error(error.legacyParameters, runSettings.complete);
                    runSettings.onComplete = runSettings.complete;
                  }
                }
                if (runSettings === undefined) {
                  module.error(error.noReturnedValue);
                }
                return (runSettings !== undefined) ? runSettings : settings;
                ;
              },
              urlEncodedValue: function(value) {
                var decodedValue = window.decodeURIComponent(value),
                    encodedValue = window.encodeURIComponent(value),
                    alreadyEncoded = (decodedValue !== value);
                ;
                if (alreadyEncoded) {
                  module.debug('URL value is already encoded, avoiding double encoding', value);
                  return value;
                }
                module.verbose('Encoding value using encodeURIComponent', value, encodedValue);
                return encodedValue;
              },
              defaultData: function() {
                var data = {};
                ;
                if (!$.isWindow(element)) {
                  if (module.is.input()) {
                    data.value = $module.val();
                  } else if (!module.is.form()) {} else {
                    data.text = $module.text();
                  }
                }
                return data;
              },
              event: function() {
                if ($.isWindow(element) || settings.on == 'now') {
                  module.debug('API called without element, no events attached');
                  return false;
                } else if (settings.on == 'auto') {
                  if ($module.is('input')) {
                    return (element.oninput !== undefined) ? 'input' : (element.onpropertychange !== undefined) ? 'propertychange' : 'keyup';
                    ;
                  } else if ($module.is('form')) {
                    return 'submit';
                  } else {
                    return 'click';
                  }
                } else {
                  return settings.on;
                }
              },
              templatedURL: function(action) {
                action = action || $module.data(metadata.action) || settings.action || false;
                url = $module.data(metadata.url) || settings.url || false;
                if (url) {
                  module.debug('Using specified url', url);
                  return url;
                }
                if (action) {
                  module.debug('Looking up url for action', action, settings.api);
                  if (settings.api[action] === undefined && !module.is.mocked()) {
                    module.error(error.missingAction, settings.action, settings.api);
                    return;
                  }
                  url = settings.api[action];
                } else if (module.is.form()) {
                  url = $module.attr('action') || $context.attr('action') || false;
                  module.debug('No url or action specified, defaulting to form action', url);
                }
                return url;
              }
            },
            abort: function() {
              var xhr = module.get.xhr();
              ;
              if (xhr && xhr.state() !== 'resolved') {
                module.debug('Cancelling API request');
                xhr.abort();
              }
            },
            reset: function() {
              module.remove.error();
              module.remove.loading();
            },
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.api.settings = {
        name: 'API',
        namespace: 'api',
        debug: false,
        verbose: false,
        performance: true,
        api: {},
        cache: true,
        interruptRequests: true,
        on: 'auto',
        stateContext: false,
        loadingDuration: 0,
        hideError: 'auto',
        errorDuration: 2000,
        encodeParameters: true,
        action: false,
        url: false,
        base: '',
        urlData: {},
        defaultData: true,
        serializeForm: false,
        throttle: 0,
        throttleFirstRequest: true,
        method: 'get',
        data: {},
        dataType: 'json',
        mockResponse: false,
        mockResponseAsync: false,
        beforeSend: function(settings) {
          return settings;
        },
        beforeXHR: function(xhr) {},
        onRequest: function(promise, xhr) {},
        onResponse: false,
        onSuccess: function(response, $module) {},
        onComplete: function(response, $module) {},
        onFailure: function(response, $module) {},
        onError: function(errorMessage, $module) {},
        onAbort: function(errorMessage, $module) {},
        successTest: false,
        error: {
          beforeSend: 'The before send function has aborted the request',
          error: 'There was an error with your request',
          exitConditions: 'API Request Aborted. Exit conditions met',
          JSONParse: 'JSON could not be parsed during error handling',
          legacyParameters: 'You are using legacy API success callback names',
          method: 'The method you called is not defined',
          missingAction: 'API action used but no url was defined',
          missingSerialize: 'jquery-serialize-object is required to add form data to an existing data object',
          missingURL: 'No URL specified for api event',
          noReturnedValue: 'The beforeSend callback must return a settings object, beforeSend ignored.',
          noStorage: 'Caching responses locally requires session storage',
          parseError: 'There was an error parsing your request',
          requiredParameter: 'Missing a required URL parameter: ',
          statusMessage: 'Server gave an error: ',
          timeout: 'Your request timed out'
        },
        regExp: {
          required: /\{\$*[A-z0-9]+\}/g,
          optional: /\{\/\$*[A-z0-9]+\}/g
        },
        className: {
          loading: 'loading',
          error: 'error'
        },
        selector: {
          disabled: '.disabled',
          form: 'form'
        },
        metadata: {
          action: 'action',
          url: 'url'
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.state = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            hasTouch = ('ontouchstart' in document.documentElement),
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.state.settings, parameters) : $.extend({}, $.fn.state.settings),
              error = settings.error,
              metadata = settings.metadata,
              className = settings.className,
              namespace = settings.namespace,
              states = settings.states,
              text = settings.text,
              eventNamespace = '.' + namespace,
              moduleNamespace = namespace + '-module',
              $module = $(this),
              element = this,
              instance = $module.data(moduleNamespace),
              module;
          ;
          module = {
            initialize: function() {
              module.verbose('Initializing module');
              if (settings.automatic) {
                module.add.defaults();
              }
              if (settings.context && moduleSelector !== '') {
                $(settings.context).on(moduleSelector, 'mouseenter' + eventNamespace, module.change.text).on(moduleSelector, 'mouseleave' + eventNamespace, module.reset.text).on(moduleSelector, 'click' + eventNamespace, module.toggle.state);
                ;
              } else {
                $module.on('mouseenter' + eventNamespace, module.change.text).on('mouseleave' + eventNamespace, module.reset.text).on('click' + eventNamespace, module.toggle.state);
                ;
              }
              module.instantiate();
            },
            instantiate: function() {
              module.verbose('Storing instance of module', module);
              instance = module;
              $module.data(moduleNamespace, module);
              ;
            },
            destroy: function() {
              module.verbose('Destroying previous module', instance);
              $module.off(eventNamespace).removeData(moduleNamespace);
              ;
            },
            refresh: function() {
              module.verbose('Refreshing selector cache');
              $module = $(element);
            },
            add: {defaults: function() {
                var userStates = parameters && $.isPlainObject(parameters.states) ? parameters.states : {};
                ;
                $.each(settings.defaults, function(type, typeStates) {
                  if (module.is[type] !== undefined && module.is[type]()) {
                    module.verbose('Adding default states', type, element);
                    $.extend(settings.states, typeStates, userStates);
                  }
                });
              }},
            is: {
              active: function() {
                return $module.hasClass(className.active);
              },
              loading: function() {
                return $module.hasClass(className.loading);
              },
              inactive: function() {
                return !($module.hasClass(className.active));
              },
              state: function(state) {
                if (className[state] === undefined) {
                  return false;
                }
                return $module.hasClass(className[state]);
              },
              enabled: function() {
                return !($module.is(settings.filter.active));
              },
              disabled: function() {
                return ($module.is(settings.filter.active));
              },
              textEnabled: function() {
                return !($module.is(settings.filter.text));
              },
              button: function() {
                return $module.is('.button:not(a, .submit)');
              },
              input: function() {
                return $module.is('input');
              },
              progress: function() {
                return $module.is('.ui.progress');
              }
            },
            allow: function(state) {
              module.debug('Now allowing state', state);
              states[state] = true;
            },
            disallow: function(state) {
              module.debug('No longer allowing', state);
              states[state] = false;
            },
            allows: function(state) {
              return states[state] || false;
            },
            enable: function() {
              $module.removeClass(className.disabled);
            },
            disable: function() {
              $module.addClass(className.disabled);
            },
            setState: function(state) {
              if (module.allows(state)) {
                $module.addClass(className[state]);
              }
            },
            removeState: function(state) {
              if (module.allows(state)) {
                $module.removeClass(className[state]);
              }
            },
            toggle: {state: function() {
                var apiRequest,
                    requestCancelled;
                ;
                if (module.allows('active') && module.is.enabled()) {
                  module.refresh();
                  if ($.fn.api !== undefined) {
                    apiRequest = $module.api('get request');
                    requestCancelled = $module.api('was cancelled');
                    if (requestCancelled) {
                      module.debug('API Request cancelled by beforesend');
                      settings.activateTest = function() {
                        return false;
                      };
                      settings.deactivateTest = function() {
                        return false;
                      };
                    } else if (apiRequest) {
                      module.listenTo(apiRequest);
                      return;
                    }
                  }
                  module.change.state();
                }
              }},
            listenTo: function(apiRequest) {
              module.debug('API request detected, waiting for state signal', apiRequest);
              if (apiRequest) {
                if (text.loading) {
                  module.update.text(text.loading);
                }
                $.when(apiRequest).then(function() {
                  if (apiRequest.state() == 'resolved') {
                    module.debug('API request succeeded');
                    settings.activateTest = function() {
                      return true;
                    };
                    settings.deactivateTest = function() {
                      return true;
                    };
                  } else {
                    module.debug('API request failed');
                    settings.activateTest = function() {
                      return false;
                    };
                    settings.deactivateTest = function() {
                      return false;
                    };
                  }
                  module.change.state();
                });
                ;
              }
            },
            change: {
              state: function() {
                module.debug('Determining state change direction');
                if (module.is.inactive()) {
                  module.activate();
                } else {
                  module.deactivate();
                }
                if (settings.sync) {
                  module.sync();
                }
                settings.onChange.call(element);
              },
              text: function() {
                if (module.is.textEnabled()) {
                  if (module.is.disabled()) {
                    module.verbose('Changing text to disabled text', text.hover);
                    module.update.text(text.disabled);
                  } else if (module.is.active()) {
                    if (text.hover) {
                      module.verbose('Changing text to hover text', text.hover);
                      module.update.text(text.hover);
                    } else if (text.deactivate) {
                      module.verbose('Changing text to deactivating text', text.deactivate);
                      module.update.text(text.deactivate);
                    }
                  } else {
                    if (text.hover) {
                      module.verbose('Changing text to hover text', text.hover);
                      module.update.text(text.hover);
                    } else if (text.activate) {
                      module.verbose('Changing text to activating text', text.activate);
                      module.update.text(text.activate);
                    }
                  }
                }
              }
            },
            activate: function() {
              if (settings.activateTest.call(element)) {
                module.debug('Setting state to active');
                $module.addClass(className.active);
                ;
                module.update.text(text.active);
                settings.onActivate.call(element);
              }
            },
            deactivate: function() {
              if (settings.deactivateTest.call(element)) {
                module.debug('Setting state to inactive');
                $module.removeClass(className.active);
                ;
                module.update.text(text.inactive);
                settings.onDeactivate.call(element);
              }
            },
            sync: function() {
              module.verbose('Syncing other buttons to current state');
              if (module.is.active()) {
                $allModules.not($module).state('activate');
              } else {
                $allModules.not($module).state('deactivate');
                ;
              }
            },
            get: {
              text: function() {
                return (settings.selector.text) ? $module.find(settings.selector.text).text() : $module.html();
                ;
              },
              textFor: function(state) {
                return text[state] || false;
              }
            },
            flash: {text: function(text, duration, callback) {
                var previousText = module.get.text();
                ;
                module.debug('Flashing text message', text, duration);
                text = text || settings.text.flash;
                duration = duration || settings.flashDuration;
                callback = callback || function() {};
                module.update.text(text);
                setTimeout(function() {
                  module.update.text(previousText);
                  callback.call(element);
                }, duration);
              }},
            reset: {text: function() {
                var activeText = text.active || $module.data(metadata.storedText),
                    inactiveText = text.inactive || $module.data(metadata.storedText);
                ;
                if (module.is.textEnabled()) {
                  if (module.is.active() && activeText) {
                    module.verbose('Resetting active text', activeText);
                    module.update.text(activeText);
                  } else if (inactiveText) {
                    module.verbose('Resetting inactive text', activeText);
                    module.update.text(inactiveText);
                  }
                }
              }},
            update: {text: function(text) {
                var currentText = module.get.text();
                ;
                if (text && text !== currentText) {
                  module.debug('Updating text', text);
                  if (settings.selector.text) {
                    $module.data(metadata.storedText, text).find(settings.selector.text).text(text);
                    ;
                  } else {
                    $module.data(metadata.storedText, text).html(text);
                    ;
                  }
                } else {
                  module.debug('Text is already set, ignoring update', text);
                }
              }},
            setting: function(name, value) {
              module.debug('Changing setting', name, value);
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.state.settings = {
        name: 'State',
        debug: false,
        verbose: false,
        namespace: 'state',
        performance: true,
        onActivate: function() {},
        onDeactivate: function() {},
        onChange: function() {},
        activateTest: function() {
          return true;
        },
        deactivateTest: function() {
          return true;
        },
        automatic: true,
        sync: false,
        flashDuration: 1000,
        filter: {
          text: '.loading, .disabled',
          active: '.disabled'
        },
        context: false,
        error: {
          beforeSend: 'The before send function has cancelled state change',
          method: 'The method you called is not defined.'
        },
        metadata: {
          promise: 'promise',
          storedText: 'stored-text'
        },
        className: {
          active: 'active',
          disabled: 'disabled',
          error: 'error',
          loading: 'loading',
          success: 'success',
          warning: 'warning'
        },
        selector: {text: false},
        defaults: {
          input: {
            disabled: true,
            loading: true,
            active: true
          },
          button: {
            disabled: true,
            loading: true,
            active: true
          },
          progress: {
            active: true,
            success: true,
            warning: true,
            error: true
          }
        },
        states: {
          active: true,
          disabled: true,
          error: true,
          loading: true,
          success: true,
          warning: true
        },
        text: {
          disabled: false,
          flash: false,
          hover: false,
          active: false,
          inactive: false,
          activate: false,
          deactivate: false
        }
      };
    })(jQuery, window, document);
    ;
    (function($, window, document, undefined) {
      "use strict";
      $.fn.visibility = function(parameters) {
        var $allModules = $(this),
            moduleSelector = $allModules.selector || '',
            time = new Date().getTime(),
            performance = [],
            query = arguments[0],
            methodInvoked = (typeof query == 'string'),
            queryArguments = [].slice.call(arguments, 1),
            returnedValue;
        ;
        $allModules.each(function() {
          var settings = ($.isPlainObject(parameters)) ? $.extend(true, {}, $.fn.visibility.settings, parameters) : $.extend({}, $.fn.visibility.settings),
              className = settings.className,
              namespace = settings.namespace,
              error = settings.error,
              metadata = settings.metadata,
              eventNamespace = '.' + namespace,
              moduleNamespace = 'module-' + namespace,
              $window = $(window),
              $module = $(this),
              $context = $(settings.context),
              $placeholder,
              selector = $module.selector || '',
              instance = $module.data(moduleNamespace),
              requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
                setTimeout(callback, 0);
              },
              element = this,
              disabled = false,
              observer,
              module;
          ;
          module = {
            initialize: function() {
              module.debug('Initializing', settings);
              module.setup.cache();
              if (module.should.trackChanges()) {
                if (settings.type == 'image') {
                  module.setup.image();
                }
                if (settings.type == 'fixed') {
                  module.setup.fixed();
                }
                if (settings.observeChanges) {
                  module.observeChanges();
                }
                module.bind.events();
              }
              module.save.position();
              if (!module.is.visible()) {
                module.error(error.visible, $module);
              }
              if (settings.initialCheck) {
                module.checkVisibility();
              }
              module.instantiate();
            },
            instantiate: function() {
              module.debug('Storing instance', module);
              $module.data(moduleNamespace, module);
              ;
              instance = module;
            },
            destroy: function() {
              module.verbose('Destroying previous module');
              if (observer) {
                observer.disconnect();
              }
              $window.off('load' + eventNamespace, module.event.load).off('resize' + eventNamespace, module.event.resize);
              ;
              $context.off('scrollchange' + eventNamespace, module.event.scrollchange);
              ;
              $module.off(eventNamespace).removeData(moduleNamespace);
              ;
            },
            observeChanges: function() {
              if ('MutationObserver' in window) {
                observer = new MutationObserver(function(mutations) {
                  module.verbose('DOM tree modified, updating visibility calculations');
                  module.timer = setTimeout(function() {
                    module.verbose('DOM tree modified, updating sticky menu');
                    module.refresh();
                  }, 100);
                });
                observer.observe(element, {
                  childList: true,
                  subtree: true
                });
                module.debug('Setting up mutation observer', observer);
              }
            },
            bind: {events: function() {
                module.verbose('Binding visibility events to scroll and resize');
                if (settings.refreshOnLoad) {
                  $window.on('load' + eventNamespace, module.event.load);
                  ;
                }
                $window.on('resize' + eventNamespace, module.event.resize);
                ;
                $context.off('scroll' + eventNamespace).on('scroll' + eventNamespace, module.event.scroll).on('scrollchange' + eventNamespace, module.event.scrollchange);
                ;
              }},
            event: {
              resize: function() {
                module.debug('Window resized');
                if (settings.refreshOnResize) {
                  requestAnimationFrame(module.refresh);
                }
              },
              load: function() {
                module.debug('Page finished loading');
                requestAnimationFrame(module.refresh);
              },
              scroll: function() {
                if (settings.throttle) {
                  clearTimeout(module.timer);
                  module.timer = setTimeout(function() {
                    $context.triggerHandler('scrollchange' + eventNamespace, [$context.scrollTop()]);
                  }, settings.throttle);
                } else {
                  requestAnimationFrame(function() {
                    $context.triggerHandler('scrollchange' + eventNamespace, [$context.scrollTop()]);
                  });
                }
              },
              scrollchange: function(event, scrollPosition) {
                module.checkVisibility(scrollPosition);
              }
            },
            precache: function(images, callback) {
              if (!(images instanceof Array)) {
                images = [images];
              }
              var imagesLength = images.length,
                  loadedCounter = 0,
                  cache = [],
                  cacheImage = document.createElement('img'),
                  handleLoad = function() {
                    loadedCounter++;
                    if (loadedCounter >= images.length) {
                      if ($.isFunction(callback)) {
                        callback();
                      }
                    }
                  };
              ;
              while (imagesLength--) {
                cacheImage = document.createElement('img');
                cacheImage.onload = handleLoad;
                cacheImage.onerror = handleLoad;
                cacheImage.src = images[imagesLength];
                cache.push(cacheImage);
              }
            },
            enableCallbacks: function() {
              module.debug('Allowing callbacks to occur');
              disabled = false;
            },
            disableCallbacks: function() {
              module.debug('Disabling all callbacks temporarily');
              disabled = true;
            },
            should: {trackChanges: function() {
                if (methodInvoked) {
                  module.debug('One time query, no need to bind events');
                  return false;
                }
                module.debug('Callbacks being attached');
                return true;
              }},
            setup: {
              cache: function() {
                module.cache = {
                  occurred: {},
                  screen: {},
                  element: {}
                };
              },
              image: function() {
                var src = $module.data(metadata.src);
                ;
                if (src) {
                  module.verbose('Lazy loading image', src);
                  settings.once = true;
                  settings.observeChanges = false;
                  settings.onOnScreen = function() {
                    module.debug('Image on screen', element);
                    module.precache(src, function() {
                      module.set.image(src);
                    });
                  };
                }
              },
              fixed: function() {
                module.debug('Setting up fixed');
                settings.once = false;
                settings.observeChanges = false;
                settings.initialCheck = true;
                settings.refreshOnLoad = true;
                if (!parameters.transition) {
                  settings.transition = false;
                }
                module.create.placeholder();
                module.debug('Added placeholder', $placeholder);
                settings.onTopPassed = function() {
                  module.debug('Element passed, adding fixed position', $module);
                  module.show.placeholder();
                  module.set.fixed();
                  if (settings.transition) {
                    if ($.fn.transition !== undefined) {
                      $module.transition(settings.transition, settings.duration);
                    }
                  }
                };
                settings.onTopPassedReverse = function() {
                  module.debug('Element returned to position, removing fixed', $module);
                  module.hide.placeholder();
                  module.remove.fixed();
                };
              }
            },
            create: {placeholder: function() {
                module.verbose('Creating fixed position placeholder');
                $placeholder = $module.clone(false).css('display', 'none').addClass(className.placeholder).insertAfter($module);
                ;
              }},
            show: {placeholder: function() {
                module.verbose('Showing placeholder');
                $placeholder.css('display', 'block').css('visibility', 'hidden');
                ;
              }},
            hide: {placeholder: function() {
                module.verbose('Hiding placeholder');
                $placeholder.css('display', 'none').css('visibility', '');
                ;
              }},
            set: {
              fixed: function() {
                module.verbose('Setting element to fixed position');
                $module.addClass(className.fixed).css({
                  position: 'fixed',
                  top: settings.offset + 'px',
                  left: 'auto',
                  zIndex: '1'
                });
                ;
              },
              image: function(src) {
                $module.attr('src', src);
                ;
                if (settings.transition) {
                  if ($.fn.transition !== undefined) {
                    $module.transition(settings.transition, settings.duration);
                  } else {
                    $module.fadeIn(settings.duration);
                  }
                } else {
                  $module.show();
                }
              }
            },
            is: {
              onScreen: function() {
                var calculations = module.get.elementCalculations();
                ;
                return calculations.onScreen;
              },
              offScreen: function() {
                var calculations = module.get.elementCalculations();
                ;
                return calculations.offScreen;
              },
              visible: function() {
                if (module.cache && module.cache.element) {
                  return !(module.cache.element.width === 0 && module.cache.element.offset.top === 0);
                }
                return false;
              }
            },
            refresh: function() {
              module.debug('Refreshing constants (width/height)');
              if (settings.type == 'fixed') {
                module.remove.fixed();
                module.remove.occurred();
              }
              module.reset();
              module.save.position();
              if (settings.checkOnRefresh) {
                module.checkVisibility();
              }
              settings.onRefresh.call(element);
            },
            reset: function() {
              module.verbose('Reseting all cached values');
              if ($.isPlainObject(module.cache)) {
                module.cache.screen = {};
                module.cache.element = {};
              }
            },
            checkVisibility: function(scroll) {
              module.verbose('Checking visibility of element', module.cache.element);
              if (!disabled && module.is.visible()) {
                module.save.scroll(scroll);
                module.save.calculations();
                module.passed();
                module.passingReverse();
                module.topVisibleReverse();
                module.bottomVisibleReverse();
                module.topPassedReverse();
                module.bottomPassedReverse();
                module.onScreen();
                module.offScreen();
                module.passing();
                module.topVisible();
                module.bottomVisible();
                module.topPassed();
                module.bottomPassed();
                if (settings.onUpdate) {
                  settings.onUpdate.call(element, module.get.elementCalculations());
                }
              }
            },
            passed: function(amount, newCallback) {
              var calculations = module.get.elementCalculations(),
                  amountInPixels;
              ;
              if (amount && newCallback) {
                settings.onPassed[amount] = newCallback;
              } else if (amount !== undefined) {
                return (module.get.pixelsPassed(amount) > calculations.pixelsPassed);
              } else if (calculations.passing) {
                $.each(settings.onPassed, function(amount, callback) {
                  if (calculations.bottomVisible || calculations.pixelsPassed > module.get.pixelsPassed(amount)) {
                    module.execute(callback, amount);
                  } else if (!settings.once) {
                    module.remove.occurred(callback);
                  }
                });
              }
            },
            onScreen: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onOnScreen,
                  callbackName = 'onScreen';
              ;
              if (newCallback) {
                module.debug('Adding callback for onScreen', newCallback);
                settings.onOnScreen = newCallback;
              }
              if (calculations.onScreen) {
                module.execute(callback, callbackName);
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback !== undefined) {
                return calculations.onOnScreen;
              }
            },
            offScreen: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onOffScreen,
                  callbackName = 'offScreen';
              ;
              if (newCallback) {
                module.debug('Adding callback for offScreen', newCallback);
                settings.onOffScreen = newCallback;
              }
              if (calculations.offScreen) {
                module.execute(callback, callbackName);
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback !== undefined) {
                return calculations.onOffScreen;
              }
            },
            passing: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onPassing,
                  callbackName = 'passing';
              ;
              if (newCallback) {
                module.debug('Adding callback for passing', newCallback);
                settings.onPassing = newCallback;
              }
              if (calculations.passing) {
                module.execute(callback, callbackName);
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback !== undefined) {
                return calculations.passing;
              }
            },
            topVisible: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onTopVisible,
                  callbackName = 'topVisible';
              ;
              if (newCallback) {
                module.debug('Adding callback for top visible', newCallback);
                settings.onTopVisible = newCallback;
              }
              if (calculations.topVisible) {
                module.execute(callback, callbackName);
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback === undefined) {
                return calculations.topVisible;
              }
            },
            bottomVisible: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onBottomVisible,
                  callbackName = 'bottomVisible';
              ;
              if (newCallback) {
                module.debug('Adding callback for bottom visible', newCallback);
                settings.onBottomVisible = newCallback;
              }
              if (calculations.bottomVisible) {
                module.execute(callback, callbackName);
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback === undefined) {
                return calculations.bottomVisible;
              }
            },
            topPassed: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onTopPassed,
                  callbackName = 'topPassed';
              ;
              if (newCallback) {
                module.debug('Adding callback for top passed', newCallback);
                settings.onTopPassed = newCallback;
              }
              if (calculations.topPassed) {
                module.execute(callback, callbackName);
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback === undefined) {
                return calculations.topPassed;
              }
            },
            bottomPassed: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onBottomPassed,
                  callbackName = 'bottomPassed';
              ;
              if (newCallback) {
                module.debug('Adding callback for bottom passed', newCallback);
                settings.onBottomPassed = newCallback;
              }
              if (calculations.bottomPassed) {
                module.execute(callback, callbackName);
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback === undefined) {
                return calculations.bottomPassed;
              }
            },
            passingReverse: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onPassingReverse,
                  callbackName = 'passingReverse';
              ;
              if (newCallback) {
                module.debug('Adding callback for passing reverse', newCallback);
                settings.onPassingReverse = newCallback;
              }
              if (!calculations.passing) {
                if (module.get.occurred('passing')) {
                  module.execute(callback, callbackName);
                }
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback !== undefined) {
                return !calculations.passing;
              }
            },
            topVisibleReverse: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onTopVisibleReverse,
                  callbackName = 'topVisibleReverse';
              ;
              if (newCallback) {
                module.debug('Adding callback for top visible reverse', newCallback);
                settings.onTopVisibleReverse = newCallback;
              }
              if (!calculations.topVisible) {
                if (module.get.occurred('topVisible')) {
                  module.execute(callback, callbackName);
                }
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback === undefined) {
                return !calculations.topVisible;
              }
            },
            bottomVisibleReverse: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onBottomVisibleReverse,
                  callbackName = 'bottomVisibleReverse';
              ;
              if (newCallback) {
                module.debug('Adding callback for bottom visible reverse', newCallback);
                settings.onBottomVisibleReverse = newCallback;
              }
              if (!calculations.bottomVisible) {
                if (module.get.occurred('bottomVisible')) {
                  module.execute(callback, callbackName);
                }
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback === undefined) {
                return !calculations.bottomVisible;
              }
            },
            topPassedReverse: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onTopPassedReverse,
                  callbackName = 'topPassedReverse';
              ;
              if (newCallback) {
                module.debug('Adding callback for top passed reverse', newCallback);
                settings.onTopPassedReverse = newCallback;
              }
              if (!calculations.topPassed) {
                if (module.get.occurred('topPassed')) {
                  module.execute(callback, callbackName);
                }
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback === undefined) {
                return !calculations.onTopPassed;
              }
            },
            bottomPassedReverse: function(newCallback) {
              var calculations = module.get.elementCalculations(),
                  callback = newCallback || settings.onBottomPassedReverse,
                  callbackName = 'bottomPassedReverse';
              ;
              if (newCallback) {
                module.debug('Adding callback for bottom passed reverse', newCallback);
                settings.onBottomPassedReverse = newCallback;
              }
              if (!calculations.bottomPassed) {
                if (module.get.occurred('bottomPassed')) {
                  module.execute(callback, callbackName);
                }
              } else if (!settings.once) {
                module.remove.occurred(callbackName);
              }
              if (newCallback === undefined) {
                return !calculations.bottomPassed;
              }
            },
            execute: function(callback, callbackName) {
              var calculations = module.get.elementCalculations(),
                  screen = module.get.screenCalculations();
              ;
              callback = callback || false;
              if (callback) {
                if (settings.continuous) {
                  module.debug('Callback being called continuously', callbackName, calculations);
                  callback.call(element, calculations, screen);
                } else if (!module.get.occurred(callbackName)) {
                  module.debug('Conditions met', callbackName, calculations);
                  callback.call(element, calculations, screen);
                }
              }
              module.save.occurred(callbackName);
            },
            remove: {
              fixed: function() {
                module.debug('Removing fixed position');
                $module.removeClass(className.fixed).css({
                  position: '',
                  top: '',
                  left: '',
                  zIndex: ''
                });
                ;
              },
              occurred: function(callback) {
                if (callback) {
                  var occurred = module.cache.occurred;
                  ;
                  if (occurred[callback] !== undefined && occurred[callback] === true) {
                    module.debug('Callback can now be called again', callback);
                    module.cache.occurred[callback] = false;
                  }
                } else {
                  module.cache.occurred = {};
                }
              }
            },
            save: {
              calculations: function() {
                module.verbose('Saving all calculations necessary to determine positioning');
                module.save.direction();
                module.save.screenCalculations();
                module.save.elementCalculations();
              },
              occurred: function(callback) {
                if (callback) {
                  if (module.cache.occurred[callback] === undefined || (module.cache.occurred[callback] !== true)) {
                    module.verbose('Saving callback occurred', callback);
                    module.cache.occurred[callback] = true;
                  }
                }
              },
              scroll: function(scrollPosition) {
                scrollPosition = scrollPosition + settings.offset || $context.scrollTop() + settings.offset;
                module.cache.scroll = scrollPosition;
              },
              direction: function() {
                var scroll = module.get.scroll(),
                    lastScroll = module.get.lastScroll(),
                    direction;
                ;
                if (scroll > lastScroll && lastScroll) {
                  direction = 'down';
                } else if (scroll < lastScroll && lastScroll) {
                  direction = 'up';
                } else {
                  direction = 'static';
                }
                module.cache.direction = direction;
                return module.cache.direction;
              },
              elementPosition: function() {
                var element = module.cache.element,
                    screen = module.get.screenSize();
                ;
                module.verbose('Saving element position');
                element.fits = (element.height < screen.height);
                element.offset = $module.offset();
                element.width = $module.outerWidth();
                element.height = $module.outerHeight();
                module.cache.element = element;
                return element;
              },
              elementCalculations: function() {
                var screen = module.get.screenCalculations(),
                    element = module.get.elementPosition();
                ;
                if (settings.includeMargin) {
                  element.margin = {};
                  element.margin.top = parseInt($module.css('margin-top'), 10);
                  element.margin.bottom = parseInt($module.css('margin-bottom'), 10);
                  element.top = element.offset.top - element.margin.top;
                  element.bottom = element.offset.top + element.height + element.margin.bottom;
                } else {
                  element.top = element.offset.top;
                  element.bottom = element.offset.top + element.height;
                }
                element.topVisible = (screen.bottom >= element.top);
                element.topPassed = (screen.top >= element.top);
                element.bottomVisible = (screen.bottom >= element.bottom);
                element.bottomPassed = (screen.top >= element.bottom);
                element.pixelsPassed = 0;
                element.percentagePassed = 0;
                element.onScreen = (element.topVisible && !element.bottomPassed);
                element.passing = (element.topPassed && !element.bottomPassed);
                element.offScreen = (!element.onScreen);
                if (element.passing) {
                  element.pixelsPassed = (screen.top - element.top);
                  element.percentagePassed = (screen.top - element.top) / element.height;
                }
                module.cache.element = element;
                module.verbose('Updated element calculations', element);
                return element;
              },
              screenCalculations: function() {
                var scroll = module.get.scroll();
                ;
                module.save.direction();
                module.cache.screen.top = scroll;
                module.cache.screen.bottom = scroll + module.cache.screen.height;
                return module.cache.screen;
              },
              screenSize: function() {
                module.verbose('Saving window position');
                module.cache.screen = {height: $context.height()};
              },
              position: function() {
                module.save.screenSize();
                module.save.elementPosition();
              }
            },
            get: {
              pixelsPassed: function(amount) {
                var element = module.get.elementCalculations();
                ;
                if (amount.search('%') > -1) {
                  return (element.height * (parseInt(amount, 10) / 100));
                }
                return parseInt(amount, 10);
              },
              occurred: function(callback) {
                return (module.cache.occurred !== undefined) ? module.cache.occurred[callback] || false : false;
                ;
              },
              direction: function() {
                if (module.cache.direction === undefined) {
                  module.save.direction();
                }
                return module.cache.direction;
              },
              elementPosition: function() {
                if (module.cache.element === undefined) {
                  module.save.elementPosition();
                }
                return module.cache.element;
              },
              elementCalculations: function() {
                if (module.cache.element === undefined) {
                  module.save.elementCalculations();
                }
                return module.cache.element;
              },
              screenCalculations: function() {
                if (module.cache.screen === undefined) {
                  module.save.screenCalculations();
                }
                return module.cache.screen;
              },
              screenSize: function() {
                if (module.cache.screen === undefined) {
                  module.save.screenSize();
                }
                return module.cache.screen;
              },
              scroll: function() {
                if (module.cache.scroll === undefined) {
                  module.save.scroll();
                }
                return module.cache.scroll;
              },
              lastScroll: function() {
                if (module.cache.screen === undefined) {
                  module.debug('First scroll event, no last scroll could be found');
                  return false;
                }
                return module.cache.screen.top;
              }
            },
            setting: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, settings, name);
              } else if (value !== undefined) {
                settings[name] = value;
              } else {
                return settings[name];
              }
            },
            internal: function(name, value) {
              if ($.isPlainObject(name)) {
                $.extend(true, module, name);
              } else if (value !== undefined) {
                module[name] = value;
              } else {
                return module[name];
              }
            },
            debug: function() {
              if (settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.debug = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.debug.apply(console, arguments);
                }
              }
            },
            verbose: function() {
              if (settings.verbose && settings.debug) {
                if (settings.performance) {
                  module.performance.log(arguments);
                } else {
                  module.verbose = Function.prototype.bind.call(console.info, console, settings.name + ':');
                  module.verbose.apply(console, arguments);
                }
              }
            },
            error: function() {
              module.error = Function.prototype.bind.call(console.error, console, settings.name + ':');
              module.error.apply(console, arguments);
            },
            performance: {
              log: function(message) {
                var currentTime,
                    executionTime,
                    previousTime;
                ;
                if (settings.performance) {
                  currentTime = new Date().getTime();
                  previousTime = time || currentTime;
                  executionTime = currentTime - previousTime;
                  time = currentTime;
                  performance.push({
                    'Name': message[0],
                    'Arguments': [].slice.call(message, 1) || '',
                    'Element': element,
                    'Execution Time': executionTime
                  });
                }
                clearTimeout(module.performance.timer);
                module.performance.timer = setTimeout(module.performance.display, 500);
              },
              display: function() {
                var title = settings.name + ':',
                    totalTime = 0;
                ;
                time = false;
                clearTimeout(module.performance.timer);
                $.each(performance, function(index, data) {
                  totalTime += data['Execution Time'];
                });
                title += ' ' + totalTime + 'ms';
                if (moduleSelector) {
                  title += ' \'' + moduleSelector + '\'';
                }
                if ((console.group !== undefined || console.table !== undefined) && performance.length > 0) {
                  console.groupCollapsed(title);
                  if (console.table) {
                    console.table(performance);
                  } else {
                    $.each(performance, function(index, data) {
                      console.log(data['Name'] + ': ' + data['Execution Time'] + 'ms');
                    });
                  }
                  console.groupEnd();
                }
                performance = [];
              }
            },
            invoke: function(query, passedArguments, context) {
              var object = instance,
                  maxDepth,
                  found,
                  response;
              ;
              passedArguments = passedArguments || queryArguments;
              context = element || context;
              if (typeof query == 'string' && object !== undefined) {
                query = query.split(/[\. ]/);
                maxDepth = query.length - 1;
                $.each(query, function(depth, value) {
                  var camelCaseValue = (depth != maxDepth) ? value + query[depth + 1].charAt(0).toUpperCase() + query[depth + 1].slice(1) : query;
                  ;
                  if ($.isPlainObject(object[camelCaseValue]) && (depth != maxDepth)) {
                    object = object[camelCaseValue];
                  } else if (object[camelCaseValue] !== undefined) {
                    found = object[camelCaseValue];
                    return false;
                  } else if ($.isPlainObject(object[value]) && (depth != maxDepth)) {
                    object = object[value];
                  } else if (object[value] !== undefined) {
                    found = object[value];
                    return false;
                  } else {
                    module.error(error.method, query);
                    return false;
                  }
                });
              }
              if ($.isFunction(found)) {
                response = found.apply(context, passedArguments);
              } else if (found !== undefined) {
                response = found;
              }
              if ($.isArray(returnedValue)) {
                returnedValue.push(response);
              } else if (returnedValue !== undefined) {
                returnedValue = [returnedValue, response];
              } else if (response !== undefined) {
                returnedValue = response;
              }
              return found;
            }
          };
          if (methodInvoked) {
            if (instance === undefined) {
              module.initialize();
            }
            instance.save.scroll();
            instance.save.calculations();
            module.invoke(query);
          } else {
            if (instance !== undefined) {
              instance.invoke('destroy');
            }
            module.initialize();
          }
        });
        ;
        return (returnedValue !== undefined) ? returnedValue : this;
        ;
      };
      $.fn.visibility.settings = {
        name: 'Visibility',
        namespace: 'visibility',
        debug: false,
        verbose: false,
        performance: true,
        observeChanges: true,
        initialCheck: true,
        refreshOnLoad: true,
        refreshOnResize: true,
        checkOnRefresh: true,
        once: true,
        continuous: false,
        offset: 0,
        includeMargin: false,
        context: window,
        throttle: false,
        type: false,
        transition: 'fade in',
        duration: 1000,
        onPassed: {},
        onOnScreen: false,
        onOffScreen: false,
        onPassing: false,
        onTopVisible: false,
        onBottomVisible: false,
        onTopPassed: false,
        onBottomPassed: false,
        onPassingReverse: false,
        onTopVisibleReverse: false,
        onBottomVisibleReverse: false,
        onTopPassedReverse: false,
        onBottomPassedReverse: false,
        onUpdate: false,
        onRefresh: function() {},
        metadata: {src: 'src'},
        className: {
          fixed: 'fixed',
          placeholder: 'placeholder'
        },
        error: {
          method: 'The method you called is not defined.',
          visible: 'Element is hidden, you must call refresh after element becomes visible'
        }
      };
    })(jQuery, window, document);
  })();
  return _retrieveGlobal();
});

(function() {
var _removeDefine = $__System.get("@@amd-helpers").createDefine();
(function(global, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = global.document ? factory(global, true) : function(w) {
      if (!w.document) {
        throw new Error("jQuery requires a window with a document");
      }
      return factory(w);
    };
  } else {
    factory(global);
  }
}(typeof window !== "undefined" ? window : this, function(window, noGlobal) {
  var arr = [];
  var slice = arr.slice;
  var concat = arr.concat;
  var push = arr.push;
  var indexOf = arr.indexOf;
  var class2type = {};
  var toString = class2type.toString;
  var hasOwn = class2type.hasOwnProperty;
  var support = {};
  var document = window.document,
      version = "2.1.4",
      jQuery = function(selector, context) {
        return new jQuery.fn.init(selector, context);
      },
      rtrim = /^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g,
      rmsPrefix = /^-ms-/,
      rdashAlpha = /-([\da-z])/gi,
      fcamelCase = function(all, letter) {
        return letter.toUpperCase();
      };
  jQuery.fn = jQuery.prototype = {
    jquery: version,
    constructor: jQuery,
    selector: "",
    length: 0,
    toArray: function() {
      return slice.call(this);
    },
    get: function(num) {
      return num != null ? (num < 0 ? this[num + this.length] : this[num]) : slice.call(this);
    },
    pushStack: function(elems) {
      var ret = jQuery.merge(this.constructor(), elems);
      ret.prevObject = this;
      ret.context = this.context;
      return ret;
    },
    each: function(callback, args) {
      return jQuery.each(this, callback, args);
    },
    map: function(callback) {
      return this.pushStack(jQuery.map(this, function(elem, i) {
        return callback.call(elem, i, elem);
      }));
    },
    slice: function() {
      return this.pushStack(slice.apply(this, arguments));
    },
    first: function() {
      return this.eq(0);
    },
    last: function() {
      return this.eq(-1);
    },
    eq: function(i) {
      var len = this.length,
          j = +i + (i < 0 ? len : 0);
      return this.pushStack(j >= 0 && j < len ? [this[j]] : []);
    },
    end: function() {
      return this.prevObject || this.constructor(null);
    },
    push: push,
    sort: arr.sort,
    splice: arr.splice
  };
  jQuery.extend = jQuery.fn.extend = function() {
    var options,
        name,
        src,
        copy,
        copyIsArray,
        clone,
        target = arguments[0] || {},
        i = 1,
        length = arguments.length,
        deep = false;
    if (typeof target === "boolean") {
      deep = target;
      target = arguments[i] || {};
      i++;
    }
    if (typeof target !== "object" && !jQuery.isFunction(target)) {
      target = {};
    }
    if (i === length) {
      target = this;
      i--;
    }
    for (; i < length; i++) {
      if ((options = arguments[i]) != null) {
        for (name in options) {
          src = target[name];
          copy = options[name];
          if (target === copy) {
            continue;
          }
          if (deep && copy && (jQuery.isPlainObject(copy) || (copyIsArray = jQuery.isArray(copy)))) {
            if (copyIsArray) {
              copyIsArray = false;
              clone = src && jQuery.isArray(src) ? src : [];
            } else {
              clone = src && jQuery.isPlainObject(src) ? src : {};
            }
            target[name] = jQuery.extend(deep, clone, copy);
          } else if (copy !== undefined) {
            target[name] = copy;
          }
        }
      }
    }
    return target;
  };
  jQuery.extend({
    expando: "jQuery" + (version + Math.random()).replace(/\D/g, ""),
    isReady: true,
    error: function(msg) {
      throw new Error(msg);
    },
    noop: function() {},
    isFunction: function(obj) {
      return jQuery.type(obj) === "function";
    },
    isArray: Array.isArray,
    isWindow: function(obj) {
      return obj != null && obj === obj.window;
    },
    isNumeric: function(obj) {
      return !jQuery.isArray(obj) && (obj - parseFloat(obj) + 1) >= 0;
    },
    isPlainObject: function(obj) {
      if (jQuery.type(obj) !== "object" || obj.nodeType || jQuery.isWindow(obj)) {
        return false;
      }
      if (obj.constructor && !hasOwn.call(obj.constructor.prototype, "isPrototypeOf")) {
        return false;
      }
      return true;
    },
    isEmptyObject: function(obj) {
      var name;
      for (name in obj) {
        return false;
      }
      return true;
    },
    type: function(obj) {
      if (obj == null) {
        return obj + "";
      }
      return typeof obj === "object" || typeof obj === "function" ? class2type[toString.call(obj)] || "object" : typeof obj;
    },
    globalEval: function(code) {
      var script,
          indirect = eval;
      code = jQuery.trim(code);
      if (code) {
        if (code.indexOf("use strict") === 1) {
          script = document.createElement("script");
          script.text = code;
          document.head.appendChild(script).parentNode.removeChild(script);
        } else {
          indirect(code);
        }
      }
    },
    camelCase: function(string) {
      return string.replace(rmsPrefix, "ms-").replace(rdashAlpha, fcamelCase);
    },
    nodeName: function(elem, name) {
      return elem.nodeName && elem.nodeName.toLowerCase() === name.toLowerCase();
    },
    each: function(obj, callback, args) {
      var value,
          i = 0,
          length = obj.length,
          isArray = isArraylike(obj);
      if (args) {
        if (isArray) {
          for (; i < length; i++) {
            value = callback.apply(obj[i], args);
            if (value === false) {
              break;
            }
          }
        } else {
          for (i in obj) {
            value = callback.apply(obj[i], args);
            if (value === false) {
              break;
            }
          }
        }
      } else {
        if (isArray) {
          for (; i < length; i++) {
            value = callback.call(obj[i], i, obj[i]);
            if (value === false) {
              break;
            }
          }
        } else {
          for (i in obj) {
            value = callback.call(obj[i], i, obj[i]);
            if (value === false) {
              break;
            }
          }
        }
      }
      return obj;
    },
    trim: function(text) {
      return text == null ? "" : (text + "").replace(rtrim, "");
    },
    makeArray: function(arr, results) {
      var ret = results || [];
      if (arr != null) {
        if (isArraylike(Object(arr))) {
          jQuery.merge(ret, typeof arr === "string" ? [arr] : arr);
        } else {
          push.call(ret, arr);
        }
      }
      return ret;
    },
    inArray: function(elem, arr, i) {
      return arr == null ? -1 : indexOf.call(arr, elem, i);
    },
    merge: function(first, second) {
      var len = +second.length,
          j = 0,
          i = first.length;
      for (; j < len; j++) {
        first[i++] = second[j];
      }
      first.length = i;
      return first;
    },
    grep: function(elems, callback, invert) {
      var callbackInverse,
          matches = [],
          i = 0,
          length = elems.length,
          callbackExpect = !invert;
      for (; i < length; i++) {
        callbackInverse = !callback(elems[i], i);
        if (callbackInverse !== callbackExpect) {
          matches.push(elems[i]);
        }
      }
      return matches;
    },
    map: function(elems, callback, arg) {
      var value,
          i = 0,
          length = elems.length,
          isArray = isArraylike(elems),
          ret = [];
      if (isArray) {
        for (; i < length; i++) {
          value = callback(elems[i], i, arg);
          if (value != null) {
            ret.push(value);
          }
        }
      } else {
        for (i in elems) {
          value = callback(elems[i], i, arg);
          if (value != null) {
            ret.push(value);
          }
        }
      }
      return concat.apply([], ret);
    },
    guid: 1,
    proxy: function(fn, context) {
      var tmp,
          args,
          proxy;
      if (typeof context === "string") {
        tmp = fn[context];
        context = fn;
        fn = tmp;
      }
      if (!jQuery.isFunction(fn)) {
        return undefined;
      }
      args = slice.call(arguments, 2);
      proxy = function() {
        return fn.apply(context || this, args.concat(slice.call(arguments)));
      };
      proxy.guid = fn.guid = fn.guid || jQuery.guid++;
      return proxy;
    },
    now: Date.now,
    support: support
  });
  jQuery.each("Boolean Number String Function Array Date RegExp Object Error".split(" "), function(i, name) {
    class2type["[object " + name + "]"] = name.toLowerCase();
  });
  function isArraylike(obj) {
    var length = "length" in obj && obj.length,
        type = jQuery.type(obj);
    if (type === "function" || jQuery.isWindow(obj)) {
      return false;
    }
    if (obj.nodeType === 1 && length) {
      return true;
    }
    return type === "array" || length === 0 || typeof length === "number" && length > 0 && (length - 1) in obj;
  }
  var Sizzle = (function(window) {
    var i,
        support,
        Expr,
        getText,
        isXML,
        tokenize,
        compile,
        select,
        outermostContext,
        sortInput,
        hasDuplicate,
        setDocument,
        document,
        docElem,
        documentIsHTML,
        rbuggyQSA,
        rbuggyMatches,
        matches,
        contains,
        expando = "sizzle" + 1 * new Date(),
        preferredDoc = window.document,
        dirruns = 0,
        done = 0,
        classCache = createCache(),
        tokenCache = createCache(),
        compilerCache = createCache(),
        sortOrder = function(a, b) {
          if (a === b) {
            hasDuplicate = true;
          }
          return 0;
        },
        MAX_NEGATIVE = 1 << 31,
        hasOwn = ({}).hasOwnProperty,
        arr = [],
        pop = arr.pop,
        push_native = arr.push,
        push = arr.push,
        slice = arr.slice,
        indexOf = function(list, elem) {
          var i = 0,
              len = list.length;
          for (; i < len; i++) {
            if (list[i] === elem) {
              return i;
            }
          }
          return -1;
        },
        booleans = "checked|selected|async|autofocus|autoplay|controls|defer|disabled|hidden|ismap|loop|multiple|open|readonly|required|scoped",
        whitespace = "[\\x20\\t\\r\\n\\f]",
        characterEncoding = "(?:\\\\.|[\\w-]|[^\\x00-\\xa0])+",
        identifier = characterEncoding.replace("w", "w#"),
        attributes = "\\[" + whitespace + "*(" + characterEncoding + ")(?:" + whitespace + "*([*^$|!~]?=)" + whitespace + "*(?:'((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\"|(" + identifier + "))|)" + whitespace + "*\\]",
        pseudos = ":(" + characterEncoding + ")(?:\\((" + "('((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\")|" + "((?:\\\\.|[^\\\\()[\\]]|" + attributes + ")*)|" + ".*" + ")\\)|)",
        rwhitespace = new RegExp(whitespace + "+", "g"),
        rtrim = new RegExp("^" + whitespace + "+|((?:^|[^\\\\])(?:\\\\.)*)" + whitespace + "+$", "g"),
        rcomma = new RegExp("^" + whitespace + "*," + whitespace + "*"),
        rcombinators = new RegExp("^" + whitespace + "*([>+~]|" + whitespace + ")" + whitespace + "*"),
        rattributeQuotes = new RegExp("=" + whitespace + "*([^\\]'\"]*?)" + whitespace + "*\\]", "g"),
        rpseudo = new RegExp(pseudos),
        ridentifier = new RegExp("^" + identifier + "$"),
        matchExpr = {
          "ID": new RegExp("^#(" + characterEncoding + ")"),
          "CLASS": new RegExp("^\\.(" + characterEncoding + ")"),
          "TAG": new RegExp("^(" + characterEncoding.replace("w", "w*") + ")"),
          "ATTR": new RegExp("^" + attributes),
          "PSEUDO": new RegExp("^" + pseudos),
          "CHILD": new RegExp("^:(only|first|last|nth|nth-last)-(child|of-type)(?:\\(" + whitespace + "*(even|odd|(([+-]|)(\\d*)n|)" + whitespace + "*(?:([+-]|)" + whitespace + "*(\\d+)|))" + whitespace + "*\\)|)", "i"),
          "bool": new RegExp("^(?:" + booleans + ")$", "i"),
          "needsContext": new RegExp("^" + whitespace + "*[>+~]|:(even|odd|eq|gt|lt|nth|first|last)(?:\\(" + whitespace + "*((?:-\\d)?\\d*)" + whitespace + "*\\)|)(?=[^-]|$)", "i")
        },
        rinputs = /^(?:input|select|textarea|button)$/i,
        rheader = /^h\d$/i,
        rnative = /^[^{]+\{\s*\[native \w/,
        rquickExpr = /^(?:#([\w-]+)|(\w+)|\.([\w-]+))$/,
        rsibling = /[+~]/,
        rescape = /'|\\/g,
        runescape = new RegExp("\\\\([\\da-f]{1,6}" + whitespace + "?|(" + whitespace + ")|.)", "ig"),
        funescape = function(_, escaped, escapedWhitespace) {
          var high = "0x" + escaped - 0x10000;
          return high !== high || escapedWhitespace ? escaped : high < 0 ? String.fromCharCode(high + 0x10000) : String.fromCharCode(high >> 10 | 0xD800, high & 0x3FF | 0xDC00);
        },
        unloadHandler = function() {
          setDocument();
        };
    try {
      push.apply((arr = slice.call(preferredDoc.childNodes)), preferredDoc.childNodes);
      arr[preferredDoc.childNodes.length].nodeType;
    } catch (e) {
      push = {apply: arr.length ? function(target, els) {
          push_native.apply(target, slice.call(els));
        } : function(target, els) {
          var j = target.length,
              i = 0;
          while ((target[j++] = els[i++])) {}
          target.length = j - 1;
        }};
    }
    function Sizzle(selector, context, results, seed) {
      var match,
          elem,
          m,
          nodeType,
          i,
          groups,
          old,
          nid,
          newContext,
          newSelector;
      if ((context ? context.ownerDocument || context : preferredDoc) !== document) {
        setDocument(context);
      }
      context = context || document;
      results = results || [];
      nodeType = context.nodeType;
      if (typeof selector !== "string" || !selector || nodeType !== 1 && nodeType !== 9 && nodeType !== 11) {
        return results;
      }
      if (!seed && documentIsHTML) {
        if (nodeType !== 11 && (match = rquickExpr.exec(selector))) {
          if ((m = match[1])) {
            if (nodeType === 9) {
              elem = context.getElementById(m);
              if (elem && elem.parentNode) {
                if (elem.id === m) {
                  results.push(elem);
                  return results;
                }
              } else {
                return results;
              }
            } else {
              if (context.ownerDocument && (elem = context.ownerDocument.getElementById(m)) && contains(context, elem) && elem.id === m) {
                results.push(elem);
                return results;
              }
            }
          } else if (match[2]) {
            push.apply(results, context.getElementsByTagName(selector));
            return results;
          } else if ((m = match[3]) && support.getElementsByClassName) {
            push.apply(results, context.getElementsByClassName(m));
            return results;
          }
        }
        if (support.qsa && (!rbuggyQSA || !rbuggyQSA.test(selector))) {
          nid = old = expando;
          newContext = context;
          newSelector = nodeType !== 1 && selector;
          if (nodeType === 1 && context.nodeName.toLowerCase() !== "object") {
            groups = tokenize(selector);
            if ((old = context.getAttribute("id"))) {
              nid = old.replace(rescape, "\\$&");
            } else {
              context.setAttribute("id", nid);
            }
            nid = "[id='" + nid + "'] ";
            i = groups.length;
            while (i--) {
              groups[i] = nid + toSelector(groups[i]);
            }
            newContext = rsibling.test(selector) && testContext(context.parentNode) || context;
            newSelector = groups.join(",");
          }
          if (newSelector) {
            try {
              push.apply(results, newContext.querySelectorAll(newSelector));
              return results;
            } catch (qsaError) {} finally {
              if (!old) {
                context.removeAttribute("id");
              }
            }
          }
        }
      }
      return select(selector.replace(rtrim, "$1"), context, results, seed);
    }
    function createCache() {
      var keys = [];
      function cache(key, value) {
        if (keys.push(key + " ") > Expr.cacheLength) {
          delete cache[keys.shift()];
        }
        return (cache[key + " "] = value);
      }
      return cache;
    }
    function markFunction(fn) {
      fn[expando] = true;
      return fn;
    }
    function assert(fn) {
      var div = document.createElement("div");
      try {
        return !!fn(div);
      } catch (e) {
        return false;
      } finally {
        if (div.parentNode) {
          div.parentNode.removeChild(div);
        }
        div = null;
      }
    }
    function addHandle(attrs, handler) {
      var arr = attrs.split("|"),
          i = attrs.length;
      while (i--) {
        Expr.attrHandle[arr[i]] = handler;
      }
    }
    function siblingCheck(a, b) {
      var cur = b && a,
          diff = cur && a.nodeType === 1 && b.nodeType === 1 && (~b.sourceIndex || MAX_NEGATIVE) - (~a.sourceIndex || MAX_NEGATIVE);
      if (diff) {
        return diff;
      }
      if (cur) {
        while ((cur = cur.nextSibling)) {
          if (cur === b) {
            return -1;
          }
        }
      }
      return a ? 1 : -1;
    }
    function createInputPseudo(type) {
      return function(elem) {
        var name = elem.nodeName.toLowerCase();
        return name === "input" && elem.type === type;
      };
    }
    function createButtonPseudo(type) {
      return function(elem) {
        var name = elem.nodeName.toLowerCase();
        return (name === "input" || name === "button") && elem.type === type;
      };
    }
    function createPositionalPseudo(fn) {
      return markFunction(function(argument) {
        argument = +argument;
        return markFunction(function(seed, matches) {
          var j,
              matchIndexes = fn([], seed.length, argument),
              i = matchIndexes.length;
          while (i--) {
            if (seed[(j = matchIndexes[i])]) {
              seed[j] = !(matches[j] = seed[j]);
            }
          }
        });
      });
    }
    function testContext(context) {
      return context && typeof context.getElementsByTagName !== "undefined" && context;
    }
    support = Sizzle.support = {};
    isXML = Sizzle.isXML = function(elem) {
      var documentElement = elem && (elem.ownerDocument || elem).documentElement;
      return documentElement ? documentElement.nodeName !== "HTML" : false;
    };
    setDocument = Sizzle.setDocument = function(node) {
      var hasCompare,
          parent,
          doc = node ? node.ownerDocument || node : preferredDoc;
      if (doc === document || doc.nodeType !== 9 || !doc.documentElement) {
        return document;
      }
      document = doc;
      docElem = doc.documentElement;
      parent = doc.defaultView;
      if (parent && parent !== parent.top) {
        if (parent.addEventListener) {
          parent.addEventListener("unload", unloadHandler, false);
        } else if (parent.attachEvent) {
          parent.attachEvent("onunload", unloadHandler);
        }
      }
      documentIsHTML = !isXML(doc);
      support.attributes = assert(function(div) {
        div.className = "i";
        return !div.getAttribute("className");
      });
      support.getElementsByTagName = assert(function(div) {
        div.appendChild(doc.createComment(""));
        return !div.getElementsByTagName("*").length;
      });
      support.getElementsByClassName = rnative.test(doc.getElementsByClassName);
      support.getById = assert(function(div) {
        docElem.appendChild(div).id = expando;
        return !doc.getElementsByName || !doc.getElementsByName(expando).length;
      });
      if (support.getById) {
        Expr.find["ID"] = function(id, context) {
          if (typeof context.getElementById !== "undefined" && documentIsHTML) {
            var m = context.getElementById(id);
            return m && m.parentNode ? [m] : [];
          }
        };
        Expr.filter["ID"] = function(id) {
          var attrId = id.replace(runescape, funescape);
          return function(elem) {
            return elem.getAttribute("id") === attrId;
          };
        };
      } else {
        delete Expr.find["ID"];
        Expr.filter["ID"] = function(id) {
          var attrId = id.replace(runescape, funescape);
          return function(elem) {
            var node = typeof elem.getAttributeNode !== "undefined" && elem.getAttributeNode("id");
            return node && node.value === attrId;
          };
        };
      }
      Expr.find["TAG"] = support.getElementsByTagName ? function(tag, context) {
        if (typeof context.getElementsByTagName !== "undefined") {
          return context.getElementsByTagName(tag);
        } else if (support.qsa) {
          return context.querySelectorAll(tag);
        }
      } : function(tag, context) {
        var elem,
            tmp = [],
            i = 0,
            results = context.getElementsByTagName(tag);
        if (tag === "*") {
          while ((elem = results[i++])) {
            if (elem.nodeType === 1) {
              tmp.push(elem);
            }
          }
          return tmp;
        }
        return results;
      };
      Expr.find["CLASS"] = support.getElementsByClassName && function(className, context) {
        if (documentIsHTML) {
          return context.getElementsByClassName(className);
        }
      };
      rbuggyMatches = [];
      rbuggyQSA = [];
      if ((support.qsa = rnative.test(doc.querySelectorAll))) {
        assert(function(div) {
          docElem.appendChild(div).innerHTML = "<a id='" + expando + "'></a>" + "<select id='" + expando + "-\f]' msallowcapture=''>" + "<option selected=''></option></select>";
          if (div.querySelectorAll("[msallowcapture^='']").length) {
            rbuggyQSA.push("[*^$]=" + whitespace + "*(?:''|\"\")");
          }
          if (!div.querySelectorAll("[selected]").length) {
            rbuggyQSA.push("\\[" + whitespace + "*(?:value|" + booleans + ")");
          }
          if (!div.querySelectorAll("[id~=" + expando + "-]").length) {
            rbuggyQSA.push("~=");
          }
          if (!div.querySelectorAll(":checked").length) {
            rbuggyQSA.push(":checked");
          }
          if (!div.querySelectorAll("a#" + expando + "+*").length) {
            rbuggyQSA.push(".#.+[+~]");
          }
        });
        assert(function(div) {
          var input = doc.createElement("input");
          input.setAttribute("type", "hidden");
          div.appendChild(input).setAttribute("name", "D");
          if (div.querySelectorAll("[name=d]").length) {
            rbuggyQSA.push("name" + whitespace + "*[*^$|!~]?=");
          }
          if (!div.querySelectorAll(":enabled").length) {
            rbuggyQSA.push(":enabled", ":disabled");
          }
          div.querySelectorAll("*,:x");
          rbuggyQSA.push(",.*:");
        });
      }
      if ((support.matchesSelector = rnative.test((matches = docElem.matches || docElem.webkitMatchesSelector || docElem.mozMatchesSelector || docElem.oMatchesSelector || docElem.msMatchesSelector)))) {
        assert(function(div) {
          support.disconnectedMatch = matches.call(div, "div");
          matches.call(div, "[s!='']:x");
          rbuggyMatches.push("!=", pseudos);
        });
      }
      rbuggyQSA = rbuggyQSA.length && new RegExp(rbuggyQSA.join("|"));
      rbuggyMatches = rbuggyMatches.length && new RegExp(rbuggyMatches.join("|"));
      hasCompare = rnative.test(docElem.compareDocumentPosition);
      contains = hasCompare || rnative.test(docElem.contains) ? function(a, b) {
        var adown = a.nodeType === 9 ? a.documentElement : a,
            bup = b && b.parentNode;
        return a === bup || !!(bup && bup.nodeType === 1 && (adown.contains ? adown.contains(bup) : a.compareDocumentPosition && a.compareDocumentPosition(bup) & 16));
      } : function(a, b) {
        if (b) {
          while ((b = b.parentNode)) {
            if (b === a) {
              return true;
            }
          }
        }
        return false;
      };
      sortOrder = hasCompare ? function(a, b) {
        if (a === b) {
          hasDuplicate = true;
          return 0;
        }
        var compare = !a.compareDocumentPosition - !b.compareDocumentPosition;
        if (compare) {
          return compare;
        }
        compare = (a.ownerDocument || a) === (b.ownerDocument || b) ? a.compareDocumentPosition(b) : 1;
        if (compare & 1 || (!support.sortDetached && b.compareDocumentPosition(a) === compare)) {
          if (a === doc || a.ownerDocument === preferredDoc && contains(preferredDoc, a)) {
            return -1;
          }
          if (b === doc || b.ownerDocument === preferredDoc && contains(preferredDoc, b)) {
            return 1;
          }
          return sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
        }
        return compare & 4 ? -1 : 1;
      } : function(a, b) {
        if (a === b) {
          hasDuplicate = true;
          return 0;
        }
        var cur,
            i = 0,
            aup = a.parentNode,
            bup = b.parentNode,
            ap = [a],
            bp = [b];
        if (!aup || !bup) {
          return a === doc ? -1 : b === doc ? 1 : aup ? -1 : bup ? 1 : sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
        } else if (aup === bup) {
          return siblingCheck(a, b);
        }
        cur = a;
        while ((cur = cur.parentNode)) {
          ap.unshift(cur);
        }
        cur = b;
        while ((cur = cur.parentNode)) {
          bp.unshift(cur);
        }
        while (ap[i] === bp[i]) {
          i++;
        }
        return i ? siblingCheck(ap[i], bp[i]) : ap[i] === preferredDoc ? -1 : bp[i] === preferredDoc ? 1 : 0;
      };
      return doc;
    };
    Sizzle.matches = function(expr, elements) {
      return Sizzle(expr, null, null, elements);
    };
    Sizzle.matchesSelector = function(elem, expr) {
      if ((elem.ownerDocument || elem) !== document) {
        setDocument(elem);
      }
      expr = expr.replace(rattributeQuotes, "='$1']");
      if (support.matchesSelector && documentIsHTML && (!rbuggyMatches || !rbuggyMatches.test(expr)) && (!rbuggyQSA || !rbuggyQSA.test(expr))) {
        try {
          var ret = matches.call(elem, expr);
          if (ret || support.disconnectedMatch || elem.document && elem.document.nodeType !== 11) {
            return ret;
          }
        } catch (e) {}
      }
      return Sizzle(expr, document, null, [elem]).length > 0;
    };
    Sizzle.contains = function(context, elem) {
      if ((context.ownerDocument || context) !== document) {
        setDocument(context);
      }
      return contains(context, elem);
    };
    Sizzle.attr = function(elem, name) {
      if ((elem.ownerDocument || elem) !== document) {
        setDocument(elem);
      }
      var fn = Expr.attrHandle[name.toLowerCase()],
          val = fn && hasOwn.call(Expr.attrHandle, name.toLowerCase()) ? fn(elem, name, !documentIsHTML) : undefined;
      return val !== undefined ? val : support.attributes || !documentIsHTML ? elem.getAttribute(name) : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
    };
    Sizzle.error = function(msg) {
      throw new Error("Syntax error, unrecognized expression: " + msg);
    };
    Sizzle.uniqueSort = function(results) {
      var elem,
          duplicates = [],
          j = 0,
          i = 0;
      hasDuplicate = !support.detectDuplicates;
      sortInput = !support.sortStable && results.slice(0);
      results.sort(sortOrder);
      if (hasDuplicate) {
        while ((elem = results[i++])) {
          if (elem === results[i]) {
            j = duplicates.push(i);
          }
        }
        while (j--) {
          results.splice(duplicates[j], 1);
        }
      }
      sortInput = null;
      return results;
    };
    getText = Sizzle.getText = function(elem) {
      var node,
          ret = "",
          i = 0,
          nodeType = elem.nodeType;
      if (!nodeType) {
        while ((node = elem[i++])) {
          ret += getText(node);
        }
      } else if (nodeType === 1 || nodeType === 9 || nodeType === 11) {
        if (typeof elem.textContent === "string") {
          return elem.textContent;
        } else {
          for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
            ret += getText(elem);
          }
        }
      } else if (nodeType === 3 || nodeType === 4) {
        return elem.nodeValue;
      }
      return ret;
    };
    Expr = Sizzle.selectors = {
      cacheLength: 50,
      createPseudo: markFunction,
      match: matchExpr,
      attrHandle: {},
      find: {},
      relative: {
        ">": {
          dir: "parentNode",
          first: true
        },
        " ": {dir: "parentNode"},
        "+": {
          dir: "previousSibling",
          first: true
        },
        "~": {dir: "previousSibling"}
      },
      preFilter: {
        "ATTR": function(match) {
          match[1] = match[1].replace(runescape, funescape);
          match[3] = (match[3] || match[4] || match[5] || "").replace(runescape, funescape);
          if (match[2] === "~=") {
            match[3] = " " + match[3] + " ";
          }
          return match.slice(0, 4);
        },
        "CHILD": function(match) {
          match[1] = match[1].toLowerCase();
          if (match[1].slice(0, 3) === "nth") {
            if (!match[3]) {
              Sizzle.error(match[0]);
            }
            match[4] = +(match[4] ? match[5] + (match[6] || 1) : 2 * (match[3] === "even" || match[3] === "odd"));
            match[5] = +((match[7] + match[8]) || match[3] === "odd");
          } else if (match[3]) {
            Sizzle.error(match[0]);
          }
          return match;
        },
        "PSEUDO": function(match) {
          var excess,
              unquoted = !match[6] && match[2];
          if (matchExpr["CHILD"].test(match[0])) {
            return null;
          }
          if (match[3]) {
            match[2] = match[4] || match[5] || "";
          } else if (unquoted && rpseudo.test(unquoted) && (excess = tokenize(unquoted, true)) && (excess = unquoted.indexOf(")", unquoted.length - excess) - unquoted.length)) {
            match[0] = match[0].slice(0, excess);
            match[2] = unquoted.slice(0, excess);
          }
          return match.slice(0, 3);
        }
      },
      filter: {
        "TAG": function(nodeNameSelector) {
          var nodeName = nodeNameSelector.replace(runescape, funescape).toLowerCase();
          return nodeNameSelector === "*" ? function() {
            return true;
          } : function(elem) {
            return elem.nodeName && elem.nodeName.toLowerCase() === nodeName;
          };
        },
        "CLASS": function(className) {
          var pattern = classCache[className + " "];
          return pattern || (pattern = new RegExp("(^|" + whitespace + ")" + className + "(" + whitespace + "|$)")) && classCache(className, function(elem) {
            return pattern.test(typeof elem.className === "string" && elem.className || typeof elem.getAttribute !== "undefined" && elem.getAttribute("class") || "");
          });
        },
        "ATTR": function(name, operator, check) {
          return function(elem) {
            var result = Sizzle.attr(elem, name);
            if (result == null) {
              return operator === "!=";
            }
            if (!operator) {
              return true;
            }
            result += "";
            return operator === "=" ? result === check : operator === "!=" ? result !== check : operator === "^=" ? check && result.indexOf(check) === 0 : operator === "*=" ? check && result.indexOf(check) > -1 : operator === "$=" ? check && result.slice(-check.length) === check : operator === "~=" ? (" " + result.replace(rwhitespace, " ") + " ").indexOf(check) > -1 : operator === "|=" ? result === check || result.slice(0, check.length + 1) === check + "-" : false;
          };
        },
        "CHILD": function(type, what, argument, first, last) {
          var simple = type.slice(0, 3) !== "nth",
              forward = type.slice(-4) !== "last",
              ofType = what === "of-type";
          return first === 1 && last === 0 ? function(elem) {
            return !!elem.parentNode;
          } : function(elem, context, xml) {
            var cache,
                outerCache,
                node,
                diff,
                nodeIndex,
                start,
                dir = simple !== forward ? "nextSibling" : "previousSibling",
                parent = elem.parentNode,
                name = ofType && elem.nodeName.toLowerCase(),
                useCache = !xml && !ofType;
            if (parent) {
              if (simple) {
                while (dir) {
                  node = elem;
                  while ((node = node[dir])) {
                    if (ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) {
                      return false;
                    }
                  }
                  start = dir = type === "only" && !start && "nextSibling";
                }
                return true;
              }
              start = [forward ? parent.firstChild : parent.lastChild];
              if (forward && useCache) {
                outerCache = parent[expando] || (parent[expando] = {});
                cache = outerCache[type] || [];
                nodeIndex = cache[0] === dirruns && cache[1];
                diff = cache[0] === dirruns && cache[2];
                node = nodeIndex && parent.childNodes[nodeIndex];
                while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                  if (node.nodeType === 1 && ++diff && node === elem) {
                    outerCache[type] = [dirruns, nodeIndex, diff];
                    break;
                  }
                }
              } else if (useCache && (cache = (elem[expando] || (elem[expando] = {}))[type]) && cache[0] === dirruns) {
                diff = cache[1];
              } else {
                while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                  if ((ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) && ++diff) {
                    if (useCache) {
                      (node[expando] || (node[expando] = {}))[type] = [dirruns, diff];
                    }
                    if (node === elem) {
                      break;
                    }
                  }
                }
              }
              diff -= last;
              return diff === first || (diff % first === 0 && diff / first >= 0);
            }
          };
        },
        "PSEUDO": function(pseudo, argument) {
          var args,
              fn = Expr.pseudos[pseudo] || Expr.setFilters[pseudo.toLowerCase()] || Sizzle.error("unsupported pseudo: " + pseudo);
          if (fn[expando]) {
            return fn(argument);
          }
          if (fn.length > 1) {
            args = [pseudo, pseudo, "", argument];
            return Expr.setFilters.hasOwnProperty(pseudo.toLowerCase()) ? markFunction(function(seed, matches) {
              var idx,
                  matched = fn(seed, argument),
                  i = matched.length;
              while (i--) {
                idx = indexOf(seed, matched[i]);
                seed[idx] = !(matches[idx] = matched[i]);
              }
            }) : function(elem) {
              return fn(elem, 0, args);
            };
          }
          return fn;
        }
      },
      pseudos: {
        "not": markFunction(function(selector) {
          var input = [],
              results = [],
              matcher = compile(selector.replace(rtrim, "$1"));
          return matcher[expando] ? markFunction(function(seed, matches, context, xml) {
            var elem,
                unmatched = matcher(seed, null, xml, []),
                i = seed.length;
            while (i--) {
              if ((elem = unmatched[i])) {
                seed[i] = !(matches[i] = elem);
              }
            }
          }) : function(elem, context, xml) {
            input[0] = elem;
            matcher(input, null, xml, results);
            input[0] = null;
            return !results.pop();
          };
        }),
        "has": markFunction(function(selector) {
          return function(elem) {
            return Sizzle(selector, elem).length > 0;
          };
        }),
        "contains": markFunction(function(text) {
          text = text.replace(runescape, funescape);
          return function(elem) {
            return (elem.textContent || elem.innerText || getText(elem)).indexOf(text) > -1;
          };
        }),
        "lang": markFunction(function(lang) {
          if (!ridentifier.test(lang || "")) {
            Sizzle.error("unsupported lang: " + lang);
          }
          lang = lang.replace(runescape, funescape).toLowerCase();
          return function(elem) {
            var elemLang;
            do {
              if ((elemLang = documentIsHTML ? elem.lang : elem.getAttribute("xml:lang") || elem.getAttribute("lang"))) {
                elemLang = elemLang.toLowerCase();
                return elemLang === lang || elemLang.indexOf(lang + "-") === 0;
              }
            } while ((elem = elem.parentNode) && elem.nodeType === 1);
            return false;
          };
        }),
        "target": function(elem) {
          var hash = window.location && window.location.hash;
          return hash && hash.slice(1) === elem.id;
        },
        "root": function(elem) {
          return elem === docElem;
        },
        "focus": function(elem) {
          return elem === document.activeElement && (!document.hasFocus || document.hasFocus()) && !!(elem.type || elem.href || ~elem.tabIndex);
        },
        "enabled": function(elem) {
          return elem.disabled === false;
        },
        "disabled": function(elem) {
          return elem.disabled === true;
        },
        "checked": function(elem) {
          var nodeName = elem.nodeName.toLowerCase();
          return (nodeName === "input" && !!elem.checked) || (nodeName === "option" && !!elem.selected);
        },
        "selected": function(elem) {
          if (elem.parentNode) {
            elem.parentNode.selectedIndex;
          }
          return elem.selected === true;
        },
        "empty": function(elem) {
          for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
            if (elem.nodeType < 6) {
              return false;
            }
          }
          return true;
        },
        "parent": function(elem) {
          return !Expr.pseudos["empty"](elem);
        },
        "header": function(elem) {
          return rheader.test(elem.nodeName);
        },
        "input": function(elem) {
          return rinputs.test(elem.nodeName);
        },
        "button": function(elem) {
          var name = elem.nodeName.toLowerCase();
          return name === "input" && elem.type === "button" || name === "button";
        },
        "text": function(elem) {
          var attr;
          return elem.nodeName.toLowerCase() === "input" && elem.type === "text" && ((attr = elem.getAttribute("type")) == null || attr.toLowerCase() === "text");
        },
        "first": createPositionalPseudo(function() {
          return [0];
        }),
        "last": createPositionalPseudo(function(matchIndexes, length) {
          return [length - 1];
        }),
        "eq": createPositionalPseudo(function(matchIndexes, length, argument) {
          return [argument < 0 ? argument + length : argument];
        }),
        "even": createPositionalPseudo(function(matchIndexes, length) {
          var i = 0;
          for (; i < length; i += 2) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "odd": createPositionalPseudo(function(matchIndexes, length) {
          var i = 1;
          for (; i < length; i += 2) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "lt": createPositionalPseudo(function(matchIndexes, length, argument) {
          var i = argument < 0 ? argument + length : argument;
          for (; --i >= 0; ) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "gt": createPositionalPseudo(function(matchIndexes, length, argument) {
          var i = argument < 0 ? argument + length : argument;
          for (; ++i < length; ) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        })
      }
    };
    Expr.pseudos["nth"] = Expr.pseudos["eq"];
    for (i in {
      radio: true,
      checkbox: true,
      file: true,
      password: true,
      image: true
    }) {
      Expr.pseudos[i] = createInputPseudo(i);
    }
    for (i in {
      submit: true,
      reset: true
    }) {
      Expr.pseudos[i] = createButtonPseudo(i);
    }
    function setFilters() {}
    setFilters.prototype = Expr.filters = Expr.pseudos;
    Expr.setFilters = new setFilters();
    tokenize = Sizzle.tokenize = function(selector, parseOnly) {
      var matched,
          match,
          tokens,
          type,
          soFar,
          groups,
          preFilters,
          cached = tokenCache[selector + " "];
      if (cached) {
        return parseOnly ? 0 : cached.slice(0);
      }
      soFar = selector;
      groups = [];
      preFilters = Expr.preFilter;
      while (soFar) {
        if (!matched || (match = rcomma.exec(soFar))) {
          if (match) {
            soFar = soFar.slice(match[0].length) || soFar;
          }
          groups.push((tokens = []));
        }
        matched = false;
        if ((match = rcombinators.exec(soFar))) {
          matched = match.shift();
          tokens.push({
            value: matched,
            type: match[0].replace(rtrim, " ")
          });
          soFar = soFar.slice(matched.length);
        }
        for (type in Expr.filter) {
          if ((match = matchExpr[type].exec(soFar)) && (!preFilters[type] || (match = preFilters[type](match)))) {
            matched = match.shift();
            tokens.push({
              value: matched,
              type: type,
              matches: match
            });
            soFar = soFar.slice(matched.length);
          }
        }
        if (!matched) {
          break;
        }
      }
      return parseOnly ? soFar.length : soFar ? Sizzle.error(selector) : tokenCache(selector, groups).slice(0);
    };
    function toSelector(tokens) {
      var i = 0,
          len = tokens.length,
          selector = "";
      for (; i < len; i++) {
        selector += tokens[i].value;
      }
      return selector;
    }
    function addCombinator(matcher, combinator, base) {
      var dir = combinator.dir,
          checkNonElements = base && dir === "parentNode",
          doneName = done++;
      return combinator.first ? function(elem, context, xml) {
        while ((elem = elem[dir])) {
          if (elem.nodeType === 1 || checkNonElements) {
            return matcher(elem, context, xml);
          }
        }
      } : function(elem, context, xml) {
        var oldCache,
            outerCache,
            newCache = [dirruns, doneName];
        if (xml) {
          while ((elem = elem[dir])) {
            if (elem.nodeType === 1 || checkNonElements) {
              if (matcher(elem, context, xml)) {
                return true;
              }
            }
          }
        } else {
          while ((elem = elem[dir])) {
            if (elem.nodeType === 1 || checkNonElements) {
              outerCache = elem[expando] || (elem[expando] = {});
              if ((oldCache = outerCache[dir]) && oldCache[0] === dirruns && oldCache[1] === doneName) {
                return (newCache[2] = oldCache[2]);
              } else {
                outerCache[dir] = newCache;
                if ((newCache[2] = matcher(elem, context, xml))) {
                  return true;
                }
              }
            }
          }
        }
      };
    }
    function elementMatcher(matchers) {
      return matchers.length > 1 ? function(elem, context, xml) {
        var i = matchers.length;
        while (i--) {
          if (!matchers[i](elem, context, xml)) {
            return false;
          }
        }
        return true;
      } : matchers[0];
    }
    function multipleContexts(selector, contexts, results) {
      var i = 0,
          len = contexts.length;
      for (; i < len; i++) {
        Sizzle(selector, contexts[i], results);
      }
      return results;
    }
    function condense(unmatched, map, filter, context, xml) {
      var elem,
          newUnmatched = [],
          i = 0,
          len = unmatched.length,
          mapped = map != null;
      for (; i < len; i++) {
        if ((elem = unmatched[i])) {
          if (!filter || filter(elem, context, xml)) {
            newUnmatched.push(elem);
            if (mapped) {
              map.push(i);
            }
          }
        }
      }
      return newUnmatched;
    }
    function setMatcher(preFilter, selector, matcher, postFilter, postFinder, postSelector) {
      if (postFilter && !postFilter[expando]) {
        postFilter = setMatcher(postFilter);
      }
      if (postFinder && !postFinder[expando]) {
        postFinder = setMatcher(postFinder, postSelector);
      }
      return markFunction(function(seed, results, context, xml) {
        var temp,
            i,
            elem,
            preMap = [],
            postMap = [],
            preexisting = results.length,
            elems = seed || multipleContexts(selector || "*", context.nodeType ? [context] : context, []),
            matcherIn = preFilter && (seed || !selector) ? condense(elems, preMap, preFilter, context, xml) : elems,
            matcherOut = matcher ? postFinder || (seed ? preFilter : preexisting || postFilter) ? [] : results : matcherIn;
        if (matcher) {
          matcher(matcherIn, matcherOut, context, xml);
        }
        if (postFilter) {
          temp = condense(matcherOut, postMap);
          postFilter(temp, [], context, xml);
          i = temp.length;
          while (i--) {
            if ((elem = temp[i])) {
              matcherOut[postMap[i]] = !(matcherIn[postMap[i]] = elem);
            }
          }
        }
        if (seed) {
          if (postFinder || preFilter) {
            if (postFinder) {
              temp = [];
              i = matcherOut.length;
              while (i--) {
                if ((elem = matcherOut[i])) {
                  temp.push((matcherIn[i] = elem));
                }
              }
              postFinder(null, (matcherOut = []), temp, xml);
            }
            i = matcherOut.length;
            while (i--) {
              if ((elem = matcherOut[i]) && (temp = postFinder ? indexOf(seed, elem) : preMap[i]) > -1) {
                seed[temp] = !(results[temp] = elem);
              }
            }
          }
        } else {
          matcherOut = condense(matcherOut === results ? matcherOut.splice(preexisting, matcherOut.length) : matcherOut);
          if (postFinder) {
            postFinder(null, results, matcherOut, xml);
          } else {
            push.apply(results, matcherOut);
          }
        }
      });
    }
    function matcherFromTokens(tokens) {
      var checkContext,
          matcher,
          j,
          len = tokens.length,
          leadingRelative = Expr.relative[tokens[0].type],
          implicitRelative = leadingRelative || Expr.relative[" "],
          i = leadingRelative ? 1 : 0,
          matchContext = addCombinator(function(elem) {
            return elem === checkContext;
          }, implicitRelative, true),
          matchAnyContext = addCombinator(function(elem) {
            return indexOf(checkContext, elem) > -1;
          }, implicitRelative, true),
          matchers = [function(elem, context, xml) {
            var ret = (!leadingRelative && (xml || context !== outermostContext)) || ((checkContext = context).nodeType ? matchContext(elem, context, xml) : matchAnyContext(elem, context, xml));
            checkContext = null;
            return ret;
          }];
      for (; i < len; i++) {
        if ((matcher = Expr.relative[tokens[i].type])) {
          matchers = [addCombinator(elementMatcher(matchers), matcher)];
        } else {
          matcher = Expr.filter[tokens[i].type].apply(null, tokens[i].matches);
          if (matcher[expando]) {
            j = ++i;
            for (; j < len; j++) {
              if (Expr.relative[tokens[j].type]) {
                break;
              }
            }
            return setMatcher(i > 1 && elementMatcher(matchers), i > 1 && toSelector(tokens.slice(0, i - 1).concat({value: tokens[i - 2].type === " " ? "*" : ""})).replace(rtrim, "$1"), matcher, i < j && matcherFromTokens(tokens.slice(i, j)), j < len && matcherFromTokens((tokens = tokens.slice(j))), j < len && toSelector(tokens));
          }
          matchers.push(matcher);
        }
      }
      return elementMatcher(matchers);
    }
    function matcherFromGroupMatchers(elementMatchers, setMatchers) {
      var bySet = setMatchers.length > 0,
          byElement = elementMatchers.length > 0,
          superMatcher = function(seed, context, xml, results, outermost) {
            var elem,
                j,
                matcher,
                matchedCount = 0,
                i = "0",
                unmatched = seed && [],
                setMatched = [],
                contextBackup = outermostContext,
                elems = seed || byElement && Expr.find["TAG"]("*", outermost),
                dirrunsUnique = (dirruns += contextBackup == null ? 1 : Math.random() || 0.1),
                len = elems.length;
            if (outermost) {
              outermostContext = context !== document && context;
            }
            for (; i !== len && (elem = elems[i]) != null; i++) {
              if (byElement && elem) {
                j = 0;
                while ((matcher = elementMatchers[j++])) {
                  if (matcher(elem, context, xml)) {
                    results.push(elem);
                    break;
                  }
                }
                if (outermost) {
                  dirruns = dirrunsUnique;
                }
              }
              if (bySet) {
                if ((elem = !matcher && elem)) {
                  matchedCount--;
                }
                if (seed) {
                  unmatched.push(elem);
                }
              }
            }
            matchedCount += i;
            if (bySet && i !== matchedCount) {
              j = 0;
              while ((matcher = setMatchers[j++])) {
                matcher(unmatched, setMatched, context, xml);
              }
              if (seed) {
                if (matchedCount > 0) {
                  while (i--) {
                    if (!(unmatched[i] || setMatched[i])) {
                      setMatched[i] = pop.call(results);
                    }
                  }
                }
                setMatched = condense(setMatched);
              }
              push.apply(results, setMatched);
              if (outermost && !seed && setMatched.length > 0 && (matchedCount + setMatchers.length) > 1) {
                Sizzle.uniqueSort(results);
              }
            }
            if (outermost) {
              dirruns = dirrunsUnique;
              outermostContext = contextBackup;
            }
            return unmatched;
          };
      return bySet ? markFunction(superMatcher) : superMatcher;
    }
    compile = Sizzle.compile = function(selector, match) {
      var i,
          setMatchers = [],
          elementMatchers = [],
          cached = compilerCache[selector + " "];
      if (!cached) {
        if (!match) {
          match = tokenize(selector);
        }
        i = match.length;
        while (i--) {
          cached = matcherFromTokens(match[i]);
          if (cached[expando]) {
            setMatchers.push(cached);
          } else {
            elementMatchers.push(cached);
          }
        }
        cached = compilerCache(selector, matcherFromGroupMatchers(elementMatchers, setMatchers));
        cached.selector = selector;
      }
      return cached;
    };
    select = Sizzle.select = function(selector, context, results, seed) {
      var i,
          tokens,
          token,
          type,
          find,
          compiled = typeof selector === "function" && selector,
          match = !seed && tokenize((selector = compiled.selector || selector));
      results = results || [];
      if (match.length === 1) {
        tokens = match[0] = match[0].slice(0);
        if (tokens.length > 2 && (token = tokens[0]).type === "ID" && support.getById && context.nodeType === 9 && documentIsHTML && Expr.relative[tokens[1].type]) {
          context = (Expr.find["ID"](token.matches[0].replace(runescape, funescape), context) || [])[0];
          if (!context) {
            return results;
          } else if (compiled) {
            context = context.parentNode;
          }
          selector = selector.slice(tokens.shift().value.length);
        }
        i = matchExpr["needsContext"].test(selector) ? 0 : tokens.length;
        while (i--) {
          token = tokens[i];
          if (Expr.relative[(type = token.type)]) {
            break;
          }
          if ((find = Expr.find[type])) {
            if ((seed = find(token.matches[0].replace(runescape, funescape), rsibling.test(tokens[0].type) && testContext(context.parentNode) || context))) {
              tokens.splice(i, 1);
              selector = seed.length && toSelector(tokens);
              if (!selector) {
                push.apply(results, seed);
                return results;
              }
              break;
            }
          }
        }
      }
      (compiled || compile(selector, match))(seed, context, !documentIsHTML, results, rsibling.test(selector) && testContext(context.parentNode) || context);
      return results;
    };
    support.sortStable = expando.split("").sort(sortOrder).join("") === expando;
    support.detectDuplicates = !!hasDuplicate;
    setDocument();
    support.sortDetached = assert(function(div1) {
      return div1.compareDocumentPosition(document.createElement("div")) & 1;
    });
    if (!assert(function(div) {
      div.innerHTML = "<a href='#'></a>";
      return div.firstChild.getAttribute("href") === "#";
    })) {
      addHandle("type|href|height|width", function(elem, name, isXML) {
        if (!isXML) {
          return elem.getAttribute(name, name.toLowerCase() === "type" ? 1 : 2);
        }
      });
    }
    if (!support.attributes || !assert(function(div) {
      div.innerHTML = "<input/>";
      div.firstChild.setAttribute("value", "");
      return div.firstChild.getAttribute("value") === "";
    })) {
      addHandle("value", function(elem, name, isXML) {
        if (!isXML && elem.nodeName.toLowerCase() === "input") {
          return elem.defaultValue;
        }
      });
    }
    if (!assert(function(div) {
      return div.getAttribute("disabled") == null;
    })) {
      addHandle(booleans, function(elem, name, isXML) {
        var val;
        if (!isXML) {
          return elem[name] === true ? name.toLowerCase() : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
        }
      });
    }
    return Sizzle;
  })(window);
  jQuery.find = Sizzle;
  jQuery.expr = Sizzle.selectors;
  jQuery.expr[":"] = jQuery.expr.pseudos;
  jQuery.unique = Sizzle.uniqueSort;
  jQuery.text = Sizzle.getText;
  jQuery.isXMLDoc = Sizzle.isXML;
  jQuery.contains = Sizzle.contains;
  var rneedsContext = jQuery.expr.match.needsContext;
  var rsingleTag = (/^<(\w+)\s*\/?>(?:<\/\1>|)$/);
  var risSimple = /^.[^:#\[\.,]*$/;
  function winnow(elements, qualifier, not) {
    if (jQuery.isFunction(qualifier)) {
      return jQuery.grep(elements, function(elem, i) {
        return !!qualifier.call(elem, i, elem) !== not;
      });
    }
    if (qualifier.nodeType) {
      return jQuery.grep(elements, function(elem) {
        return (elem === qualifier) !== not;
      });
    }
    if (typeof qualifier === "string") {
      if (risSimple.test(qualifier)) {
        return jQuery.filter(qualifier, elements, not);
      }
      qualifier = jQuery.filter(qualifier, elements);
    }
    return jQuery.grep(elements, function(elem) {
      return (indexOf.call(qualifier, elem) >= 0) !== not;
    });
  }
  jQuery.filter = function(expr, elems, not) {
    var elem = elems[0];
    if (not) {
      expr = ":not(" + expr + ")";
    }
    return elems.length === 1 && elem.nodeType === 1 ? jQuery.find.matchesSelector(elem, expr) ? [elem] : [] : jQuery.find.matches(expr, jQuery.grep(elems, function(elem) {
      return elem.nodeType === 1;
    }));
  };
  jQuery.fn.extend({
    find: function(selector) {
      var i,
          len = this.length,
          ret = [],
          self = this;
      if (typeof selector !== "string") {
        return this.pushStack(jQuery(selector).filter(function() {
          for (i = 0; i < len; i++) {
            if (jQuery.contains(self[i], this)) {
              return true;
            }
          }
        }));
      }
      for (i = 0; i < len; i++) {
        jQuery.find(selector, self[i], ret);
      }
      ret = this.pushStack(len > 1 ? jQuery.unique(ret) : ret);
      ret.selector = this.selector ? this.selector + " " + selector : selector;
      return ret;
    },
    filter: function(selector) {
      return this.pushStack(winnow(this, selector || [], false));
    },
    not: function(selector) {
      return this.pushStack(winnow(this, selector || [], true));
    },
    is: function(selector) {
      return !!winnow(this, typeof selector === "string" && rneedsContext.test(selector) ? jQuery(selector) : selector || [], false).length;
    }
  });
  var rootjQuery,
      rquickExpr = /^(?:\s*(<[\w\W]+>)[^>]*|#([\w-]*))$/,
      init = jQuery.fn.init = function(selector, context) {
        var match,
            elem;
        if (!selector) {
          return this;
        }
        if (typeof selector === "string") {
          if (selector[0] === "<" && selector[selector.length - 1] === ">" && selector.length >= 3) {
            match = [null, selector, null];
          } else {
            match = rquickExpr.exec(selector);
          }
          if (match && (match[1] || !context)) {
            if (match[1]) {
              context = context instanceof jQuery ? context[0] : context;
              jQuery.merge(this, jQuery.parseHTML(match[1], context && context.nodeType ? context.ownerDocument || context : document, true));
              if (rsingleTag.test(match[1]) && jQuery.isPlainObject(context)) {
                for (match in context) {
                  if (jQuery.isFunction(this[match])) {
                    this[match](context[match]);
                  } else {
                    this.attr(match, context[match]);
                  }
                }
              }
              return this;
            } else {
              elem = document.getElementById(match[2]);
              if (elem && elem.parentNode) {
                this.length = 1;
                this[0] = elem;
              }
              this.context = document;
              this.selector = selector;
              return this;
            }
          } else if (!context || context.jquery) {
            return (context || rootjQuery).find(selector);
          } else {
            return this.constructor(context).find(selector);
          }
        } else if (selector.nodeType) {
          this.context = this[0] = selector;
          this.length = 1;
          return this;
        } else if (jQuery.isFunction(selector)) {
          return typeof rootjQuery.ready !== "undefined" ? rootjQuery.ready(selector) : selector(jQuery);
        }
        if (selector.selector !== undefined) {
          this.selector = selector.selector;
          this.context = selector.context;
        }
        return jQuery.makeArray(selector, this);
      };
  init.prototype = jQuery.fn;
  rootjQuery = jQuery(document);
  var rparentsprev = /^(?:parents|prev(?:Until|All))/,
      guaranteedUnique = {
        children: true,
        contents: true,
        next: true,
        prev: true
      };
  jQuery.extend({
    dir: function(elem, dir, until) {
      var matched = [],
          truncate = until !== undefined;
      while ((elem = elem[dir]) && elem.nodeType !== 9) {
        if (elem.nodeType === 1) {
          if (truncate && jQuery(elem).is(until)) {
            break;
          }
          matched.push(elem);
        }
      }
      return matched;
    },
    sibling: function(n, elem) {
      var matched = [];
      for (; n; n = n.nextSibling) {
        if (n.nodeType === 1 && n !== elem) {
          matched.push(n);
        }
      }
      return matched;
    }
  });
  jQuery.fn.extend({
    has: function(target) {
      var targets = jQuery(target, this),
          l = targets.length;
      return this.filter(function() {
        var i = 0;
        for (; i < l; i++) {
          if (jQuery.contains(this, targets[i])) {
            return true;
          }
        }
      });
    },
    closest: function(selectors, context) {
      var cur,
          i = 0,
          l = this.length,
          matched = [],
          pos = rneedsContext.test(selectors) || typeof selectors !== "string" ? jQuery(selectors, context || this.context) : 0;
      for (; i < l; i++) {
        for (cur = this[i]; cur && cur !== context; cur = cur.parentNode) {
          if (cur.nodeType < 11 && (pos ? pos.index(cur) > -1 : cur.nodeType === 1 && jQuery.find.matchesSelector(cur, selectors))) {
            matched.push(cur);
            break;
          }
        }
      }
      return this.pushStack(matched.length > 1 ? jQuery.unique(matched) : matched);
    },
    index: function(elem) {
      if (!elem) {
        return (this[0] && this[0].parentNode) ? this.first().prevAll().length : -1;
      }
      if (typeof elem === "string") {
        return indexOf.call(jQuery(elem), this[0]);
      }
      return indexOf.call(this, elem.jquery ? elem[0] : elem);
    },
    add: function(selector, context) {
      return this.pushStack(jQuery.unique(jQuery.merge(this.get(), jQuery(selector, context))));
    },
    addBack: function(selector) {
      return this.add(selector == null ? this.prevObject : this.prevObject.filter(selector));
    }
  });
  function sibling(cur, dir) {
    while ((cur = cur[dir]) && cur.nodeType !== 1) {}
    return cur;
  }
  jQuery.each({
    parent: function(elem) {
      var parent = elem.parentNode;
      return parent && parent.nodeType !== 11 ? parent : null;
    },
    parents: function(elem) {
      return jQuery.dir(elem, "parentNode");
    },
    parentsUntil: function(elem, i, until) {
      return jQuery.dir(elem, "parentNode", until);
    },
    next: function(elem) {
      return sibling(elem, "nextSibling");
    },
    prev: function(elem) {
      return sibling(elem, "previousSibling");
    },
    nextAll: function(elem) {
      return jQuery.dir(elem, "nextSibling");
    },
    prevAll: function(elem) {
      return jQuery.dir(elem, "previousSibling");
    },
    nextUntil: function(elem, i, until) {
      return jQuery.dir(elem, "nextSibling", until);
    },
    prevUntil: function(elem, i, until) {
      return jQuery.dir(elem, "previousSibling", until);
    },
    siblings: function(elem) {
      return jQuery.sibling((elem.parentNode || {}).firstChild, elem);
    },
    children: function(elem) {
      return jQuery.sibling(elem.firstChild);
    },
    contents: function(elem) {
      return elem.contentDocument || jQuery.merge([], elem.childNodes);
    }
  }, function(name, fn) {
    jQuery.fn[name] = function(until, selector) {
      var matched = jQuery.map(this, fn, until);
      if (name.slice(-5) !== "Until") {
        selector = until;
      }
      if (selector && typeof selector === "string") {
        matched = jQuery.filter(selector, matched);
      }
      if (this.length > 1) {
        if (!guaranteedUnique[name]) {
          jQuery.unique(matched);
        }
        if (rparentsprev.test(name)) {
          matched.reverse();
        }
      }
      return this.pushStack(matched);
    };
  });
  var rnotwhite = (/\S+/g);
  var optionsCache = {};
  function createOptions(options) {
    var object = optionsCache[options] = {};
    jQuery.each(options.match(rnotwhite) || [], function(_, flag) {
      object[flag] = true;
    });
    return object;
  }
  jQuery.Callbacks = function(options) {
    options = typeof options === "string" ? (optionsCache[options] || createOptions(options)) : jQuery.extend({}, options);
    var memory,
        fired,
        firing,
        firingStart,
        firingLength,
        firingIndex,
        list = [],
        stack = !options.once && [],
        fire = function(data) {
          memory = options.memory && data;
          fired = true;
          firingIndex = firingStart || 0;
          firingStart = 0;
          firingLength = list.length;
          firing = true;
          for (; list && firingIndex < firingLength; firingIndex++) {
            if (list[firingIndex].apply(data[0], data[1]) === false && options.stopOnFalse) {
              memory = false;
              break;
            }
          }
          firing = false;
          if (list) {
            if (stack) {
              if (stack.length) {
                fire(stack.shift());
              }
            } else if (memory) {
              list = [];
            } else {
              self.disable();
            }
          }
        },
        self = {
          add: function() {
            if (list) {
              var start = list.length;
              (function add(args) {
                jQuery.each(args, function(_, arg) {
                  var type = jQuery.type(arg);
                  if (type === "function") {
                    if (!options.unique || !self.has(arg)) {
                      list.push(arg);
                    }
                  } else if (arg && arg.length && type !== "string") {
                    add(arg);
                  }
                });
              })(arguments);
              if (firing) {
                firingLength = list.length;
              } else if (memory) {
                firingStart = start;
                fire(memory);
              }
            }
            return this;
          },
          remove: function() {
            if (list) {
              jQuery.each(arguments, function(_, arg) {
                var index;
                while ((index = jQuery.inArray(arg, list, index)) > -1) {
                  list.splice(index, 1);
                  if (firing) {
                    if (index <= firingLength) {
                      firingLength--;
                    }
                    if (index <= firingIndex) {
                      firingIndex--;
                    }
                  }
                }
              });
            }
            return this;
          },
          has: function(fn) {
            return fn ? jQuery.inArray(fn, list) > -1 : !!(list && list.length);
          },
          empty: function() {
            list = [];
            firingLength = 0;
            return this;
          },
          disable: function() {
            list = stack = memory = undefined;
            return this;
          },
          disabled: function() {
            return !list;
          },
          lock: function() {
            stack = undefined;
            if (!memory) {
              self.disable();
            }
            return this;
          },
          locked: function() {
            return !stack;
          },
          fireWith: function(context, args) {
            if (list && (!fired || stack)) {
              args = args || [];
              args = [context, args.slice ? args.slice() : args];
              if (firing) {
                stack.push(args);
              } else {
                fire(args);
              }
            }
            return this;
          },
          fire: function() {
            self.fireWith(this, arguments);
            return this;
          },
          fired: function() {
            return !!fired;
          }
        };
    return self;
  };
  jQuery.extend({
    Deferred: function(func) {
      var tuples = [["resolve", "done", jQuery.Callbacks("once memory"), "resolved"], ["reject", "fail", jQuery.Callbacks("once memory"), "rejected"], ["notify", "progress", jQuery.Callbacks("memory")]],
          state = "pending",
          promise = {
            state: function() {
              return state;
            },
            always: function() {
              deferred.done(arguments).fail(arguments);
              return this;
            },
            then: function() {
              var fns = arguments;
              return jQuery.Deferred(function(newDefer) {
                jQuery.each(tuples, function(i, tuple) {
                  var fn = jQuery.isFunction(fns[i]) && fns[i];
                  deferred[tuple[1]](function() {
                    var returned = fn && fn.apply(this, arguments);
                    if (returned && jQuery.isFunction(returned.promise)) {
                      returned.promise().done(newDefer.resolve).fail(newDefer.reject).progress(newDefer.notify);
                    } else {
                      newDefer[tuple[0] + "With"](this === promise ? newDefer.promise() : this, fn ? [returned] : arguments);
                    }
                  });
                });
                fns = null;
              }).promise();
            },
            promise: function(obj) {
              return obj != null ? jQuery.extend(obj, promise) : promise;
            }
          },
          deferred = {};
      promise.pipe = promise.then;
      jQuery.each(tuples, function(i, tuple) {
        var list = tuple[2],
            stateString = tuple[3];
        promise[tuple[1]] = list.add;
        if (stateString) {
          list.add(function() {
            state = stateString;
          }, tuples[i ^ 1][2].disable, tuples[2][2].lock);
        }
        deferred[tuple[0]] = function() {
          deferred[tuple[0] + "With"](this === deferred ? promise : this, arguments);
          return this;
        };
        deferred[tuple[0] + "With"] = list.fireWith;
      });
      promise.promise(deferred);
      if (func) {
        func.call(deferred, deferred);
      }
      return deferred;
    },
    when: function(subordinate) {
      var i = 0,
          resolveValues = slice.call(arguments),
          length = resolveValues.length,
          remaining = length !== 1 || (subordinate && jQuery.isFunction(subordinate.promise)) ? length : 0,
          deferred = remaining === 1 ? subordinate : jQuery.Deferred(),
          updateFunc = function(i, contexts, values) {
            return function(value) {
              contexts[i] = this;
              values[i] = arguments.length > 1 ? slice.call(arguments) : value;
              if (values === progressValues) {
                deferred.notifyWith(contexts, values);
              } else if (!(--remaining)) {
                deferred.resolveWith(contexts, values);
              }
            };
          },
          progressValues,
          progressContexts,
          resolveContexts;
      if (length > 1) {
        progressValues = new Array(length);
        progressContexts = new Array(length);
        resolveContexts = new Array(length);
        for (; i < length; i++) {
          if (resolveValues[i] && jQuery.isFunction(resolveValues[i].promise)) {
            resolveValues[i].promise().done(updateFunc(i, resolveContexts, resolveValues)).fail(deferred.reject).progress(updateFunc(i, progressContexts, progressValues));
          } else {
            --remaining;
          }
        }
      }
      if (!remaining) {
        deferred.resolveWith(resolveContexts, resolveValues);
      }
      return deferred.promise();
    }
  });
  var readyList;
  jQuery.fn.ready = function(fn) {
    jQuery.ready.promise().done(fn);
    return this;
  };
  jQuery.extend({
    isReady: false,
    readyWait: 1,
    holdReady: function(hold) {
      if (hold) {
        jQuery.readyWait++;
      } else {
        jQuery.ready(true);
      }
    },
    ready: function(wait) {
      if (wait === true ? --jQuery.readyWait : jQuery.isReady) {
        return;
      }
      jQuery.isReady = true;
      if (wait !== true && --jQuery.readyWait > 0) {
        return;
      }
      readyList.resolveWith(document, [jQuery]);
      if (jQuery.fn.triggerHandler) {
        jQuery(document).triggerHandler("ready");
        jQuery(document).off("ready");
      }
    }
  });
  function completed() {
    document.removeEventListener("DOMContentLoaded", completed, false);
    window.removeEventListener("load", completed, false);
    jQuery.ready();
  }
  jQuery.ready.promise = function(obj) {
    if (!readyList) {
      readyList = jQuery.Deferred();
      if (document.readyState === "complete") {
        setTimeout(jQuery.ready);
      } else {
        document.addEventListener("DOMContentLoaded", completed, false);
        window.addEventListener("load", completed, false);
      }
    }
    return readyList.promise(obj);
  };
  jQuery.ready.promise();
  var access = jQuery.access = function(elems, fn, key, value, chainable, emptyGet, raw) {
    var i = 0,
        len = elems.length,
        bulk = key == null;
    if (jQuery.type(key) === "object") {
      chainable = true;
      for (i in key) {
        jQuery.access(elems, fn, i, key[i], true, emptyGet, raw);
      }
    } else if (value !== undefined) {
      chainable = true;
      if (!jQuery.isFunction(value)) {
        raw = true;
      }
      if (bulk) {
        if (raw) {
          fn.call(elems, value);
          fn = null;
        } else {
          bulk = fn;
          fn = function(elem, key, value) {
            return bulk.call(jQuery(elem), value);
          };
        }
      }
      if (fn) {
        for (; i < len; i++) {
          fn(elems[i], key, raw ? value : value.call(elems[i], i, fn(elems[i], key)));
        }
      }
    }
    return chainable ? elems : bulk ? fn.call(elems) : len ? fn(elems[0], key) : emptyGet;
  };
  jQuery.acceptData = function(owner) {
    return owner.nodeType === 1 || owner.nodeType === 9 || !(+owner.nodeType);
  };
  function Data() {
    Object.defineProperty(this.cache = {}, 0, {get: function() {
        return {};
      }});
    this.expando = jQuery.expando + Data.uid++;
  }
  Data.uid = 1;
  Data.accepts = jQuery.acceptData;
  Data.prototype = {
    key: function(owner) {
      if (!Data.accepts(owner)) {
        return 0;
      }
      var descriptor = {},
          unlock = owner[this.expando];
      if (!unlock) {
        unlock = Data.uid++;
        try {
          descriptor[this.expando] = {value: unlock};
          Object.defineProperties(owner, descriptor);
        } catch (e) {
          descriptor[this.expando] = unlock;
          jQuery.extend(owner, descriptor);
        }
      }
      if (!this.cache[unlock]) {
        this.cache[unlock] = {};
      }
      return unlock;
    },
    set: function(owner, data, value) {
      var prop,
          unlock = this.key(owner),
          cache = this.cache[unlock];
      if (typeof data === "string") {
        cache[data] = value;
      } else {
        if (jQuery.isEmptyObject(cache)) {
          jQuery.extend(this.cache[unlock], data);
        } else {
          for (prop in data) {
            cache[prop] = data[prop];
          }
        }
      }
      return cache;
    },
    get: function(owner, key) {
      var cache = this.cache[this.key(owner)];
      return key === undefined ? cache : cache[key];
    },
    access: function(owner, key, value) {
      var stored;
      if (key === undefined || ((key && typeof key === "string") && value === undefined)) {
        stored = this.get(owner, key);
        return stored !== undefined ? stored : this.get(owner, jQuery.camelCase(key));
      }
      this.set(owner, key, value);
      return value !== undefined ? value : key;
    },
    remove: function(owner, key) {
      var i,
          name,
          camel,
          unlock = this.key(owner),
          cache = this.cache[unlock];
      if (key === undefined) {
        this.cache[unlock] = {};
      } else {
        if (jQuery.isArray(key)) {
          name = key.concat(key.map(jQuery.camelCase));
        } else {
          camel = jQuery.camelCase(key);
          if (key in cache) {
            name = [key, camel];
          } else {
            name = camel;
            name = name in cache ? [name] : (name.match(rnotwhite) || []);
          }
        }
        i = name.length;
        while (i--) {
          delete cache[name[i]];
        }
      }
    },
    hasData: function(owner) {
      return !jQuery.isEmptyObject(this.cache[owner[this.expando]] || {});
    },
    discard: function(owner) {
      if (owner[this.expando]) {
        delete this.cache[owner[this.expando]];
      }
    }
  };
  var data_priv = new Data();
  var data_user = new Data();
  var rbrace = /^(?:\{[\w\W]*\}|\[[\w\W]*\])$/,
      rmultiDash = /([A-Z])/g;
  function dataAttr(elem, key, data) {
    var name;
    if (data === undefined && elem.nodeType === 1) {
      name = "data-" + key.replace(rmultiDash, "-$1").toLowerCase();
      data = elem.getAttribute(name);
      if (typeof data === "string") {
        try {
          data = data === "true" ? true : data === "false" ? false : data === "null" ? null : +data + "" === data ? +data : rbrace.test(data) ? jQuery.parseJSON(data) : data;
        } catch (e) {}
        data_user.set(elem, key, data);
      } else {
        data = undefined;
      }
    }
    return data;
  }
  jQuery.extend({
    hasData: function(elem) {
      return data_user.hasData(elem) || data_priv.hasData(elem);
    },
    data: function(elem, name, data) {
      return data_user.access(elem, name, data);
    },
    removeData: function(elem, name) {
      data_user.remove(elem, name);
    },
    _data: function(elem, name, data) {
      return data_priv.access(elem, name, data);
    },
    _removeData: function(elem, name) {
      data_priv.remove(elem, name);
    }
  });
  jQuery.fn.extend({
    data: function(key, value) {
      var i,
          name,
          data,
          elem = this[0],
          attrs = elem && elem.attributes;
      if (key === undefined) {
        if (this.length) {
          data = data_user.get(elem);
          if (elem.nodeType === 1 && !data_priv.get(elem, "hasDataAttrs")) {
            i = attrs.length;
            while (i--) {
              if (attrs[i]) {
                name = attrs[i].name;
                if (name.indexOf("data-") === 0) {
                  name = jQuery.camelCase(name.slice(5));
                  dataAttr(elem, name, data[name]);
                }
              }
            }
            data_priv.set(elem, "hasDataAttrs", true);
          }
        }
        return data;
      }
      if (typeof key === "object") {
        return this.each(function() {
          data_user.set(this, key);
        });
      }
      return access(this, function(value) {
        var data,
            camelKey = jQuery.camelCase(key);
        if (elem && value === undefined) {
          data = data_user.get(elem, key);
          if (data !== undefined) {
            return data;
          }
          data = data_user.get(elem, camelKey);
          if (data !== undefined) {
            return data;
          }
          data = dataAttr(elem, camelKey, undefined);
          if (data !== undefined) {
            return data;
          }
          return;
        }
        this.each(function() {
          var data = data_user.get(this, camelKey);
          data_user.set(this, camelKey, value);
          if (key.indexOf("-") !== -1 && data !== undefined) {
            data_user.set(this, key, value);
          }
        });
      }, null, value, arguments.length > 1, null, true);
    },
    removeData: function(key) {
      return this.each(function() {
        data_user.remove(this, key);
      });
    }
  });
  jQuery.extend({
    queue: function(elem, type, data) {
      var queue;
      if (elem) {
        type = (type || "fx") + "queue";
        queue = data_priv.get(elem, type);
        if (data) {
          if (!queue || jQuery.isArray(data)) {
            queue = data_priv.access(elem, type, jQuery.makeArray(data));
          } else {
            queue.push(data);
          }
        }
        return queue || [];
      }
    },
    dequeue: function(elem, type) {
      type = type || "fx";
      var queue = jQuery.queue(elem, type),
          startLength = queue.length,
          fn = queue.shift(),
          hooks = jQuery._queueHooks(elem, type),
          next = function() {
            jQuery.dequeue(elem, type);
          };
      if (fn === "inprogress") {
        fn = queue.shift();
        startLength--;
      }
      if (fn) {
        if (type === "fx") {
          queue.unshift("inprogress");
        }
        delete hooks.stop;
        fn.call(elem, next, hooks);
      }
      if (!startLength && hooks) {
        hooks.empty.fire();
      }
    },
    _queueHooks: function(elem, type) {
      var key = type + "queueHooks";
      return data_priv.get(elem, key) || data_priv.access(elem, key, {empty: jQuery.Callbacks("once memory").add(function() {
          data_priv.remove(elem, [type + "queue", key]);
        })});
    }
  });
  jQuery.fn.extend({
    queue: function(type, data) {
      var setter = 2;
      if (typeof type !== "string") {
        data = type;
        type = "fx";
        setter--;
      }
      if (arguments.length < setter) {
        return jQuery.queue(this[0], type);
      }
      return data === undefined ? this : this.each(function() {
        var queue = jQuery.queue(this, type, data);
        jQuery._queueHooks(this, type);
        if (type === "fx" && queue[0] !== "inprogress") {
          jQuery.dequeue(this, type);
        }
      });
    },
    dequeue: function(type) {
      return this.each(function() {
        jQuery.dequeue(this, type);
      });
    },
    clearQueue: function(type) {
      return this.queue(type || "fx", []);
    },
    promise: function(type, obj) {
      var tmp,
          count = 1,
          defer = jQuery.Deferred(),
          elements = this,
          i = this.length,
          resolve = function() {
            if (!(--count)) {
              defer.resolveWith(elements, [elements]);
            }
          };
      if (typeof type !== "string") {
        obj = type;
        type = undefined;
      }
      type = type || "fx";
      while (i--) {
        tmp = data_priv.get(elements[i], type + "queueHooks");
        if (tmp && tmp.empty) {
          count++;
          tmp.empty.add(resolve);
        }
      }
      resolve();
      return defer.promise(obj);
    }
  });
  var pnum = (/[+-]?(?:\d*\.|)\d+(?:[eE][+-]?\d+|)/).source;
  var cssExpand = ["Top", "Right", "Bottom", "Left"];
  var isHidden = function(elem, el) {
    elem = el || elem;
    return jQuery.css(elem, "display") === "none" || !jQuery.contains(elem.ownerDocument, elem);
  };
  var rcheckableType = (/^(?:checkbox|radio)$/i);
  (function() {
    var fragment = document.createDocumentFragment(),
        div = fragment.appendChild(document.createElement("div")),
        input = document.createElement("input");
    input.setAttribute("type", "radio");
    input.setAttribute("checked", "checked");
    input.setAttribute("name", "t");
    div.appendChild(input);
    support.checkClone = div.cloneNode(true).cloneNode(true).lastChild.checked;
    div.innerHTML = "<textarea>x</textarea>";
    support.noCloneChecked = !!div.cloneNode(true).lastChild.defaultValue;
  })();
  var strundefined = typeof undefined;
  support.focusinBubbles = "onfocusin" in window;
  var rkeyEvent = /^key/,
      rmouseEvent = /^(?:mouse|pointer|contextmenu)|click/,
      rfocusMorph = /^(?:focusinfocus|focusoutblur)$/,
      rtypenamespace = /^([^.]*)(?:\.(.+)|)$/;
  function returnTrue() {
    return true;
  }
  function returnFalse() {
    return false;
  }
  function safeActiveElement() {
    try {
      return document.activeElement;
    } catch (err) {}
  }
  jQuery.event = {
    global: {},
    add: function(elem, types, handler, data, selector) {
      var handleObjIn,
          eventHandle,
          tmp,
          events,
          t,
          handleObj,
          special,
          handlers,
          type,
          namespaces,
          origType,
          elemData = data_priv.get(elem);
      if (!elemData) {
        return;
      }
      if (handler.handler) {
        handleObjIn = handler;
        handler = handleObjIn.handler;
        selector = handleObjIn.selector;
      }
      if (!handler.guid) {
        handler.guid = jQuery.guid++;
      }
      if (!(events = elemData.events)) {
        events = elemData.events = {};
      }
      if (!(eventHandle = elemData.handle)) {
        eventHandle = elemData.handle = function(e) {
          return typeof jQuery !== strundefined && jQuery.event.triggered !== e.type ? jQuery.event.dispatch.apply(elem, arguments) : undefined;
        };
      }
      types = (types || "").match(rnotwhite) || [""];
      t = types.length;
      while (t--) {
        tmp = rtypenamespace.exec(types[t]) || [];
        type = origType = tmp[1];
        namespaces = (tmp[2] || "").split(".").sort();
        if (!type) {
          continue;
        }
        special = jQuery.event.special[type] || {};
        type = (selector ? special.delegateType : special.bindType) || type;
        special = jQuery.event.special[type] || {};
        handleObj = jQuery.extend({
          type: type,
          origType: origType,
          data: data,
          handler: handler,
          guid: handler.guid,
          selector: selector,
          needsContext: selector && jQuery.expr.match.needsContext.test(selector),
          namespace: namespaces.join(".")
        }, handleObjIn);
        if (!(handlers = events[type])) {
          handlers = events[type] = [];
          handlers.delegateCount = 0;
          if (!special.setup || special.setup.call(elem, data, namespaces, eventHandle) === false) {
            if (elem.addEventListener) {
              elem.addEventListener(type, eventHandle, false);
            }
          }
        }
        if (special.add) {
          special.add.call(elem, handleObj);
          if (!handleObj.handler.guid) {
            handleObj.handler.guid = handler.guid;
          }
        }
        if (selector) {
          handlers.splice(handlers.delegateCount++, 0, handleObj);
        } else {
          handlers.push(handleObj);
        }
        jQuery.event.global[type] = true;
      }
    },
    remove: function(elem, types, handler, selector, mappedTypes) {
      var j,
          origCount,
          tmp,
          events,
          t,
          handleObj,
          special,
          handlers,
          type,
          namespaces,
          origType,
          elemData = data_priv.hasData(elem) && data_priv.get(elem);
      if (!elemData || !(events = elemData.events)) {
        return;
      }
      types = (types || "").match(rnotwhite) || [""];
      t = types.length;
      while (t--) {
        tmp = rtypenamespace.exec(types[t]) || [];
        type = origType = tmp[1];
        namespaces = (tmp[2] || "").split(".").sort();
        if (!type) {
          for (type in events) {
            jQuery.event.remove(elem, type + types[t], handler, selector, true);
          }
          continue;
        }
        special = jQuery.event.special[type] || {};
        type = (selector ? special.delegateType : special.bindType) || type;
        handlers = events[type] || [];
        tmp = tmp[2] && new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)");
        origCount = j = handlers.length;
        while (j--) {
          handleObj = handlers[j];
          if ((mappedTypes || origType === handleObj.origType) && (!handler || handler.guid === handleObj.guid) && (!tmp || tmp.test(handleObj.namespace)) && (!selector || selector === handleObj.selector || selector === "**" && handleObj.selector)) {
            handlers.splice(j, 1);
            if (handleObj.selector) {
              handlers.delegateCount--;
            }
            if (special.remove) {
              special.remove.call(elem, handleObj);
            }
          }
        }
        if (origCount && !handlers.length) {
          if (!special.teardown || special.teardown.call(elem, namespaces, elemData.handle) === false) {
            jQuery.removeEvent(elem, type, elemData.handle);
          }
          delete events[type];
        }
      }
      if (jQuery.isEmptyObject(events)) {
        delete elemData.handle;
        data_priv.remove(elem, "events");
      }
    },
    trigger: function(event, data, elem, onlyHandlers) {
      var i,
          cur,
          tmp,
          bubbleType,
          ontype,
          handle,
          special,
          eventPath = [elem || document],
          type = hasOwn.call(event, "type") ? event.type : event,
          namespaces = hasOwn.call(event, "namespace") ? event.namespace.split(".") : [];
      cur = tmp = elem = elem || document;
      if (elem.nodeType === 3 || elem.nodeType === 8) {
        return;
      }
      if (rfocusMorph.test(type + jQuery.event.triggered)) {
        return;
      }
      if (type.indexOf(".") >= 0) {
        namespaces = type.split(".");
        type = namespaces.shift();
        namespaces.sort();
      }
      ontype = type.indexOf(":") < 0 && "on" + type;
      event = event[jQuery.expando] ? event : new jQuery.Event(type, typeof event === "object" && event);
      event.isTrigger = onlyHandlers ? 2 : 3;
      event.namespace = namespaces.join(".");
      event.namespace_re = event.namespace ? new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)") : null;
      event.result = undefined;
      if (!event.target) {
        event.target = elem;
      }
      data = data == null ? [event] : jQuery.makeArray(data, [event]);
      special = jQuery.event.special[type] || {};
      if (!onlyHandlers && special.trigger && special.trigger.apply(elem, data) === false) {
        return;
      }
      if (!onlyHandlers && !special.noBubble && !jQuery.isWindow(elem)) {
        bubbleType = special.delegateType || type;
        if (!rfocusMorph.test(bubbleType + type)) {
          cur = cur.parentNode;
        }
        for (; cur; cur = cur.parentNode) {
          eventPath.push(cur);
          tmp = cur;
        }
        if (tmp === (elem.ownerDocument || document)) {
          eventPath.push(tmp.defaultView || tmp.parentWindow || window);
        }
      }
      i = 0;
      while ((cur = eventPath[i++]) && !event.isPropagationStopped()) {
        event.type = i > 1 ? bubbleType : special.bindType || type;
        handle = (data_priv.get(cur, "events") || {})[event.type] && data_priv.get(cur, "handle");
        if (handle) {
          handle.apply(cur, data);
        }
        handle = ontype && cur[ontype];
        if (handle && handle.apply && jQuery.acceptData(cur)) {
          event.result = handle.apply(cur, data);
          if (event.result === false) {
            event.preventDefault();
          }
        }
      }
      event.type = type;
      if (!onlyHandlers && !event.isDefaultPrevented()) {
        if ((!special._default || special._default.apply(eventPath.pop(), data) === false) && jQuery.acceptData(elem)) {
          if (ontype && jQuery.isFunction(elem[type]) && !jQuery.isWindow(elem)) {
            tmp = elem[ontype];
            if (tmp) {
              elem[ontype] = null;
            }
            jQuery.event.triggered = type;
            elem[type]();
            jQuery.event.triggered = undefined;
            if (tmp) {
              elem[ontype] = tmp;
            }
          }
        }
      }
      return event.result;
    },
    dispatch: function(event) {
      event = jQuery.event.fix(event);
      var i,
          j,
          ret,
          matched,
          handleObj,
          handlerQueue = [],
          args = slice.call(arguments),
          handlers = (data_priv.get(this, "events") || {})[event.type] || [],
          special = jQuery.event.special[event.type] || {};
      args[0] = event;
      event.delegateTarget = this;
      if (special.preDispatch && special.preDispatch.call(this, event) === false) {
        return;
      }
      handlerQueue = jQuery.event.handlers.call(this, event, handlers);
      i = 0;
      while ((matched = handlerQueue[i++]) && !event.isPropagationStopped()) {
        event.currentTarget = matched.elem;
        j = 0;
        while ((handleObj = matched.handlers[j++]) && !event.isImmediatePropagationStopped()) {
          if (!event.namespace_re || event.namespace_re.test(handleObj.namespace)) {
            event.handleObj = handleObj;
            event.data = handleObj.data;
            ret = ((jQuery.event.special[handleObj.origType] || {}).handle || handleObj.handler).apply(matched.elem, args);
            if (ret !== undefined) {
              if ((event.result = ret) === false) {
                event.preventDefault();
                event.stopPropagation();
              }
            }
          }
        }
      }
      if (special.postDispatch) {
        special.postDispatch.call(this, event);
      }
      return event.result;
    },
    handlers: function(event, handlers) {
      var i,
          matches,
          sel,
          handleObj,
          handlerQueue = [],
          delegateCount = handlers.delegateCount,
          cur = event.target;
      if (delegateCount && cur.nodeType && (!event.button || event.type !== "click")) {
        for (; cur !== this; cur = cur.parentNode || this) {
          if (cur.disabled !== true || event.type !== "click") {
            matches = [];
            for (i = 0; i < delegateCount; i++) {
              handleObj = handlers[i];
              sel = handleObj.selector + " ";
              if (matches[sel] === undefined) {
                matches[sel] = handleObj.needsContext ? jQuery(sel, this).index(cur) >= 0 : jQuery.find(sel, this, null, [cur]).length;
              }
              if (matches[sel]) {
                matches.push(handleObj);
              }
            }
            if (matches.length) {
              handlerQueue.push({
                elem: cur,
                handlers: matches
              });
            }
          }
        }
      }
      if (delegateCount < handlers.length) {
        handlerQueue.push({
          elem: this,
          handlers: handlers.slice(delegateCount)
        });
      }
      return handlerQueue;
    },
    props: "altKey bubbles cancelable ctrlKey currentTarget eventPhase metaKey relatedTarget shiftKey target timeStamp view which".split(" "),
    fixHooks: {},
    keyHooks: {
      props: "char charCode key keyCode".split(" "),
      filter: function(event, original) {
        if (event.which == null) {
          event.which = original.charCode != null ? original.charCode : original.keyCode;
        }
        return event;
      }
    },
    mouseHooks: {
      props: "button buttons clientX clientY offsetX offsetY pageX pageY screenX screenY toElement".split(" "),
      filter: function(event, original) {
        var eventDoc,
            doc,
            body,
            button = original.button;
        if (event.pageX == null && original.clientX != null) {
          eventDoc = event.target.ownerDocument || document;
          doc = eventDoc.documentElement;
          body = eventDoc.body;
          event.pageX = original.clientX + (doc && doc.scrollLeft || body && body.scrollLeft || 0) - (doc && doc.clientLeft || body && body.clientLeft || 0);
          event.pageY = original.clientY + (doc && doc.scrollTop || body && body.scrollTop || 0) - (doc && doc.clientTop || body && body.clientTop || 0);
        }
        if (!event.which && button !== undefined) {
          event.which = (button & 1 ? 1 : (button & 2 ? 3 : (button & 4 ? 2 : 0)));
        }
        return event;
      }
    },
    fix: function(event) {
      if (event[jQuery.expando]) {
        return event;
      }
      var i,
          prop,
          copy,
          type = event.type,
          originalEvent = event,
          fixHook = this.fixHooks[type];
      if (!fixHook) {
        this.fixHooks[type] = fixHook = rmouseEvent.test(type) ? this.mouseHooks : rkeyEvent.test(type) ? this.keyHooks : {};
      }
      copy = fixHook.props ? this.props.concat(fixHook.props) : this.props;
      event = new jQuery.Event(originalEvent);
      i = copy.length;
      while (i--) {
        prop = copy[i];
        event[prop] = originalEvent[prop];
      }
      if (!event.target) {
        event.target = document;
      }
      if (event.target.nodeType === 3) {
        event.target = event.target.parentNode;
      }
      return fixHook.filter ? fixHook.filter(event, originalEvent) : event;
    },
    special: {
      load: {noBubble: true},
      focus: {
        trigger: function() {
          if (this !== safeActiveElement() && this.focus) {
            this.focus();
            return false;
          }
        },
        delegateType: "focusin"
      },
      blur: {
        trigger: function() {
          if (this === safeActiveElement() && this.blur) {
            this.blur();
            return false;
          }
        },
        delegateType: "focusout"
      },
      click: {
        trigger: function() {
          if (this.type === "checkbox" && this.click && jQuery.nodeName(this, "input")) {
            this.click();
            return false;
          }
        },
        _default: function(event) {
          return jQuery.nodeName(event.target, "a");
        }
      },
      beforeunload: {postDispatch: function(event) {
          if (event.result !== undefined && event.originalEvent) {
            event.originalEvent.returnValue = event.result;
          }
        }}
    },
    simulate: function(type, elem, event, bubble) {
      var e = jQuery.extend(new jQuery.Event(), event, {
        type: type,
        isSimulated: true,
        originalEvent: {}
      });
      if (bubble) {
        jQuery.event.trigger(e, null, elem);
      } else {
        jQuery.event.dispatch.call(elem, e);
      }
      if (e.isDefaultPrevented()) {
        event.preventDefault();
      }
    }
  };
  jQuery.removeEvent = function(elem, type, handle) {
    if (elem.removeEventListener) {
      elem.removeEventListener(type, handle, false);
    }
  };
  jQuery.Event = function(src, props) {
    if (!(this instanceof jQuery.Event)) {
      return new jQuery.Event(src, props);
    }
    if (src && src.type) {
      this.originalEvent = src;
      this.type = src.type;
      this.isDefaultPrevented = src.defaultPrevented || src.defaultPrevented === undefined && src.returnValue === false ? returnTrue : returnFalse;
    } else {
      this.type = src;
    }
    if (props) {
      jQuery.extend(this, props);
    }
    this.timeStamp = src && src.timeStamp || jQuery.now();
    this[jQuery.expando] = true;
  };
  jQuery.Event.prototype = {
    isDefaultPrevented: returnFalse,
    isPropagationStopped: returnFalse,
    isImmediatePropagationStopped: returnFalse,
    preventDefault: function() {
      var e = this.originalEvent;
      this.isDefaultPrevented = returnTrue;
      if (e && e.preventDefault) {
        e.preventDefault();
      }
    },
    stopPropagation: function() {
      var e = this.originalEvent;
      this.isPropagationStopped = returnTrue;
      if (e && e.stopPropagation) {
        e.stopPropagation();
      }
    },
    stopImmediatePropagation: function() {
      var e = this.originalEvent;
      this.isImmediatePropagationStopped = returnTrue;
      if (e && e.stopImmediatePropagation) {
        e.stopImmediatePropagation();
      }
      this.stopPropagation();
    }
  };
  jQuery.each({
    mouseenter: "mouseover",
    mouseleave: "mouseout",
    pointerenter: "pointerover",
    pointerleave: "pointerout"
  }, function(orig, fix) {
    jQuery.event.special[orig] = {
      delegateType: fix,
      bindType: fix,
      handle: function(event) {
        var ret,
            target = this,
            related = event.relatedTarget,
            handleObj = event.handleObj;
        if (!related || (related !== target && !jQuery.contains(target, related))) {
          event.type = handleObj.origType;
          ret = handleObj.handler.apply(this, arguments);
          event.type = fix;
        }
        return ret;
      }
    };
  });
  if (!support.focusinBubbles) {
    jQuery.each({
      focus: "focusin",
      blur: "focusout"
    }, function(orig, fix) {
      var handler = function(event) {
        jQuery.event.simulate(fix, event.target, jQuery.event.fix(event), true);
      };
      jQuery.event.special[fix] = {
        setup: function() {
          var doc = this.ownerDocument || this,
              attaches = data_priv.access(doc, fix);
          if (!attaches) {
            doc.addEventListener(orig, handler, true);
          }
          data_priv.access(doc, fix, (attaches || 0) + 1);
        },
        teardown: function() {
          var doc = this.ownerDocument || this,
              attaches = data_priv.access(doc, fix) - 1;
          if (!attaches) {
            doc.removeEventListener(orig, handler, true);
            data_priv.remove(doc, fix);
          } else {
            data_priv.access(doc, fix, attaches);
          }
        }
      };
    });
  }
  jQuery.fn.extend({
    on: function(types, selector, data, fn, one) {
      var origFn,
          type;
      if (typeof types === "object") {
        if (typeof selector !== "string") {
          data = data || selector;
          selector = undefined;
        }
        for (type in types) {
          this.on(type, selector, data, types[type], one);
        }
        return this;
      }
      if (data == null && fn == null) {
        fn = selector;
        data = selector = undefined;
      } else if (fn == null) {
        if (typeof selector === "string") {
          fn = data;
          data = undefined;
        } else {
          fn = data;
          data = selector;
          selector = undefined;
        }
      }
      if (fn === false) {
        fn = returnFalse;
      } else if (!fn) {
        return this;
      }
      if (one === 1) {
        origFn = fn;
        fn = function(event) {
          jQuery().off(event);
          return origFn.apply(this, arguments);
        };
        fn.guid = origFn.guid || (origFn.guid = jQuery.guid++);
      }
      return this.each(function() {
        jQuery.event.add(this, types, fn, data, selector);
      });
    },
    one: function(types, selector, data, fn) {
      return this.on(types, selector, data, fn, 1);
    },
    off: function(types, selector, fn) {
      var handleObj,
          type;
      if (types && types.preventDefault && types.handleObj) {
        handleObj = types.handleObj;
        jQuery(types.delegateTarget).off(handleObj.namespace ? handleObj.origType + "." + handleObj.namespace : handleObj.origType, handleObj.selector, handleObj.handler);
        return this;
      }
      if (typeof types === "object") {
        for (type in types) {
          this.off(type, selector, types[type]);
        }
        return this;
      }
      if (selector === false || typeof selector === "function") {
        fn = selector;
        selector = undefined;
      }
      if (fn === false) {
        fn = returnFalse;
      }
      return this.each(function() {
        jQuery.event.remove(this, types, fn, selector);
      });
    },
    trigger: function(type, data) {
      return this.each(function() {
        jQuery.event.trigger(type, data, this);
      });
    },
    triggerHandler: function(type, data) {
      var elem = this[0];
      if (elem) {
        return jQuery.event.trigger(type, data, elem, true);
      }
    }
  });
  var rxhtmlTag = /<(?!area|br|col|embed|hr|img|input|link|meta|param)(([\w:]+)[^>]*)\/>/gi,
      rtagName = /<([\w:]+)/,
      rhtml = /<|&#?\w+;/,
      rnoInnerhtml = /<(?:script|style|link)/i,
      rchecked = /checked\s*(?:[^=]|=\s*.checked.)/i,
      rscriptType = /^$|\/(?:java|ecma)script/i,
      rscriptTypeMasked = /^true\/(.*)/,
      rcleanScript = /^\s*<!(?:\[CDATA\[|--)|(?:\]\]|--)>\s*$/g,
      wrapMap = {
        option: [1, "<select multiple='multiple'>", "</select>"],
        thead: [1, "<table>", "</table>"],
        col: [2, "<table><colgroup>", "</colgroup></table>"],
        tr: [2, "<table><tbody>", "</tbody></table>"],
        td: [3, "<table><tbody><tr>", "</tr></tbody></table>"],
        _default: [0, "", ""]
      };
  wrapMap.optgroup = wrapMap.option;
  wrapMap.tbody = wrapMap.tfoot = wrapMap.colgroup = wrapMap.caption = wrapMap.thead;
  wrapMap.th = wrapMap.td;
  function manipulationTarget(elem, content) {
    return jQuery.nodeName(elem, "table") && jQuery.nodeName(content.nodeType !== 11 ? content : content.firstChild, "tr") ? elem.getElementsByTagName("tbody")[0] || elem.appendChild(elem.ownerDocument.createElement("tbody")) : elem;
  }
  function disableScript(elem) {
    elem.type = (elem.getAttribute("type") !== null) + "/" + elem.type;
    return elem;
  }
  function restoreScript(elem) {
    var match = rscriptTypeMasked.exec(elem.type);
    if (match) {
      elem.type = match[1];
    } else {
      elem.removeAttribute("type");
    }
    return elem;
  }
  function setGlobalEval(elems, refElements) {
    var i = 0,
        l = elems.length;
    for (; i < l; i++) {
      data_priv.set(elems[i], "globalEval", !refElements || data_priv.get(refElements[i], "globalEval"));
    }
  }
  function cloneCopyEvent(src, dest) {
    var i,
        l,
        type,
        pdataOld,
        pdataCur,
        udataOld,
        udataCur,
        events;
    if (dest.nodeType !== 1) {
      return;
    }
    if (data_priv.hasData(src)) {
      pdataOld = data_priv.access(src);
      pdataCur = data_priv.set(dest, pdataOld);
      events = pdataOld.events;
      if (events) {
        delete pdataCur.handle;
        pdataCur.events = {};
        for (type in events) {
          for (i = 0, l = events[type].length; i < l; i++) {
            jQuery.event.add(dest, type, events[type][i]);
          }
        }
      }
    }
    if (data_user.hasData(src)) {
      udataOld = data_user.access(src);
      udataCur = jQuery.extend({}, udataOld);
      data_user.set(dest, udataCur);
    }
  }
  function getAll(context, tag) {
    var ret = context.getElementsByTagName ? context.getElementsByTagName(tag || "*") : context.querySelectorAll ? context.querySelectorAll(tag || "*") : [];
    return tag === undefined || tag && jQuery.nodeName(context, tag) ? jQuery.merge([context], ret) : ret;
  }
  function fixInput(src, dest) {
    var nodeName = dest.nodeName.toLowerCase();
    if (nodeName === "input" && rcheckableType.test(src.type)) {
      dest.checked = src.checked;
    } else if (nodeName === "input" || nodeName === "textarea") {
      dest.defaultValue = src.defaultValue;
    }
  }
  jQuery.extend({
    clone: function(elem, dataAndEvents, deepDataAndEvents) {
      var i,
          l,
          srcElements,
          destElements,
          clone = elem.cloneNode(true),
          inPage = jQuery.contains(elem.ownerDocument, elem);
      if (!support.noCloneChecked && (elem.nodeType === 1 || elem.nodeType === 11) && !jQuery.isXMLDoc(elem)) {
        destElements = getAll(clone);
        srcElements = getAll(elem);
        for (i = 0, l = srcElements.length; i < l; i++) {
          fixInput(srcElements[i], destElements[i]);
        }
      }
      if (dataAndEvents) {
        if (deepDataAndEvents) {
          srcElements = srcElements || getAll(elem);
          destElements = destElements || getAll(clone);
          for (i = 0, l = srcElements.length; i < l; i++) {
            cloneCopyEvent(srcElements[i], destElements[i]);
          }
        } else {
          cloneCopyEvent(elem, clone);
        }
      }
      destElements = getAll(clone, "script");
      if (destElements.length > 0) {
        setGlobalEval(destElements, !inPage && getAll(elem, "script"));
      }
      return clone;
    },
    buildFragment: function(elems, context, scripts, selection) {
      var elem,
          tmp,
          tag,
          wrap,
          contains,
          j,
          fragment = context.createDocumentFragment(),
          nodes = [],
          i = 0,
          l = elems.length;
      for (; i < l; i++) {
        elem = elems[i];
        if (elem || elem === 0) {
          if (jQuery.type(elem) === "object") {
            jQuery.merge(nodes, elem.nodeType ? [elem] : elem);
          } else if (!rhtml.test(elem)) {
            nodes.push(context.createTextNode(elem));
          } else {
            tmp = tmp || fragment.appendChild(context.createElement("div"));
            tag = (rtagName.exec(elem) || ["", ""])[1].toLowerCase();
            wrap = wrapMap[tag] || wrapMap._default;
            tmp.innerHTML = wrap[1] + elem.replace(rxhtmlTag, "<$1></$2>") + wrap[2];
            j = wrap[0];
            while (j--) {
              tmp = tmp.lastChild;
            }
            jQuery.merge(nodes, tmp.childNodes);
            tmp = fragment.firstChild;
            tmp.textContent = "";
          }
        }
      }
      fragment.textContent = "";
      i = 0;
      while ((elem = nodes[i++])) {
        if (selection && jQuery.inArray(elem, selection) !== -1) {
          continue;
        }
        contains = jQuery.contains(elem.ownerDocument, elem);
        tmp = getAll(fragment.appendChild(elem), "script");
        if (contains) {
          setGlobalEval(tmp);
        }
        if (scripts) {
          j = 0;
          while ((elem = tmp[j++])) {
            if (rscriptType.test(elem.type || "")) {
              scripts.push(elem);
            }
          }
        }
      }
      return fragment;
    },
    cleanData: function(elems) {
      var data,
          elem,
          type,
          key,
          special = jQuery.event.special,
          i = 0;
      for (; (elem = elems[i]) !== undefined; i++) {
        if (jQuery.acceptData(elem)) {
          key = elem[data_priv.expando];
          if (key && (data = data_priv.cache[key])) {
            if (data.events) {
              for (type in data.events) {
                if (special[type]) {
                  jQuery.event.remove(elem, type);
                } else {
                  jQuery.removeEvent(elem, type, data.handle);
                }
              }
            }
            if (data_priv.cache[key]) {
              delete data_priv.cache[key];
            }
          }
        }
        delete data_user.cache[elem[data_user.expando]];
      }
    }
  });
  jQuery.fn.extend({
    text: function(value) {
      return access(this, function(value) {
        return value === undefined ? jQuery.text(this) : this.empty().each(function() {
          if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
            this.textContent = value;
          }
        });
      }, null, value, arguments.length);
    },
    append: function() {
      return this.domManip(arguments, function(elem) {
        if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
          var target = manipulationTarget(this, elem);
          target.appendChild(elem);
        }
      });
    },
    prepend: function() {
      return this.domManip(arguments, function(elem) {
        if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
          var target = manipulationTarget(this, elem);
          target.insertBefore(elem, target.firstChild);
        }
      });
    },
    before: function() {
      return this.domManip(arguments, function(elem) {
        if (this.parentNode) {
          this.parentNode.insertBefore(elem, this);
        }
      });
    },
    after: function() {
      return this.domManip(arguments, function(elem) {
        if (this.parentNode) {
          this.parentNode.insertBefore(elem, this.nextSibling);
        }
      });
    },
    remove: function(selector, keepData) {
      var elem,
          elems = selector ? jQuery.filter(selector, this) : this,
          i = 0;
      for (; (elem = elems[i]) != null; i++) {
        if (!keepData && elem.nodeType === 1) {
          jQuery.cleanData(getAll(elem));
        }
        if (elem.parentNode) {
          if (keepData && jQuery.contains(elem.ownerDocument, elem)) {
            setGlobalEval(getAll(elem, "script"));
          }
          elem.parentNode.removeChild(elem);
        }
      }
      return this;
    },
    empty: function() {
      var elem,
          i = 0;
      for (; (elem = this[i]) != null; i++) {
        if (elem.nodeType === 1) {
          jQuery.cleanData(getAll(elem, false));
          elem.textContent = "";
        }
      }
      return this;
    },
    clone: function(dataAndEvents, deepDataAndEvents) {
      dataAndEvents = dataAndEvents == null ? false : dataAndEvents;
      deepDataAndEvents = deepDataAndEvents == null ? dataAndEvents : deepDataAndEvents;
      return this.map(function() {
        return jQuery.clone(this, dataAndEvents, deepDataAndEvents);
      });
    },
    html: function(value) {
      return access(this, function(value) {
        var elem = this[0] || {},
            i = 0,
            l = this.length;
        if (value === undefined && elem.nodeType === 1) {
          return elem.innerHTML;
        }
        if (typeof value === "string" && !rnoInnerhtml.test(value) && !wrapMap[(rtagName.exec(value) || ["", ""])[1].toLowerCase()]) {
          value = value.replace(rxhtmlTag, "<$1></$2>");
          try {
            for (; i < l; i++) {
              elem = this[i] || {};
              if (elem.nodeType === 1) {
                jQuery.cleanData(getAll(elem, false));
                elem.innerHTML = value;
              }
            }
            elem = 0;
          } catch (e) {}
        }
        if (elem) {
          this.empty().append(value);
        }
      }, null, value, arguments.length);
    },
    replaceWith: function() {
      var arg = arguments[0];
      this.domManip(arguments, function(elem) {
        arg = this.parentNode;
        jQuery.cleanData(getAll(this));
        if (arg) {
          arg.replaceChild(elem, this);
        }
      });
      return arg && (arg.length || arg.nodeType) ? this : this.remove();
    },
    detach: function(selector) {
      return this.remove(selector, true);
    },
    domManip: function(args, callback) {
      args = concat.apply([], args);
      var fragment,
          first,
          scripts,
          hasScripts,
          node,
          doc,
          i = 0,
          l = this.length,
          set = this,
          iNoClone = l - 1,
          value = args[0],
          isFunction = jQuery.isFunction(value);
      if (isFunction || (l > 1 && typeof value === "string" && !support.checkClone && rchecked.test(value))) {
        return this.each(function(index) {
          var self = set.eq(index);
          if (isFunction) {
            args[0] = value.call(this, index, self.html());
          }
          self.domManip(args, callback);
        });
      }
      if (l) {
        fragment = jQuery.buildFragment(args, this[0].ownerDocument, false, this);
        first = fragment.firstChild;
        if (fragment.childNodes.length === 1) {
          fragment = first;
        }
        if (first) {
          scripts = jQuery.map(getAll(fragment, "script"), disableScript);
          hasScripts = scripts.length;
          for (; i < l; i++) {
            node = fragment;
            if (i !== iNoClone) {
              node = jQuery.clone(node, true, true);
              if (hasScripts) {
                jQuery.merge(scripts, getAll(node, "script"));
              }
            }
            callback.call(this[i], node, i);
          }
          if (hasScripts) {
            doc = scripts[scripts.length - 1].ownerDocument;
            jQuery.map(scripts, restoreScript);
            for (i = 0; i < hasScripts; i++) {
              node = scripts[i];
              if (rscriptType.test(node.type || "") && !data_priv.access(node, "globalEval") && jQuery.contains(doc, node)) {
                if (node.src) {
                  if (jQuery._evalUrl) {
                    jQuery._evalUrl(node.src);
                  }
                } else {
                  jQuery.globalEval(node.textContent.replace(rcleanScript, ""));
                }
              }
            }
          }
        }
      }
      return this;
    }
  });
  jQuery.each({
    appendTo: "append",
    prependTo: "prepend",
    insertBefore: "before",
    insertAfter: "after",
    replaceAll: "replaceWith"
  }, function(name, original) {
    jQuery.fn[name] = function(selector) {
      var elems,
          ret = [],
          insert = jQuery(selector),
          last = insert.length - 1,
          i = 0;
      for (; i <= last; i++) {
        elems = i === last ? this : this.clone(true);
        jQuery(insert[i])[original](elems);
        push.apply(ret, elems.get());
      }
      return this.pushStack(ret);
    };
  });
  var iframe,
      elemdisplay = {};
  function actualDisplay(name, doc) {
    var style,
        elem = jQuery(doc.createElement(name)).appendTo(doc.body),
        display = window.getDefaultComputedStyle && (style = window.getDefaultComputedStyle(elem[0])) ? style.display : jQuery.css(elem[0], "display");
    elem.detach();
    return display;
  }
  function defaultDisplay(nodeName) {
    var doc = document,
        display = elemdisplay[nodeName];
    if (!display) {
      display = actualDisplay(nodeName, doc);
      if (display === "none" || !display) {
        iframe = (iframe || jQuery("<iframe frameborder='0' width='0' height='0'/>")).appendTo(doc.documentElement);
        doc = iframe[0].contentDocument;
        doc.write();
        doc.close();
        display = actualDisplay(nodeName, doc);
        iframe.detach();
      }
      elemdisplay[nodeName] = display;
    }
    return display;
  }
  var rmargin = (/^margin/);
  var rnumnonpx = new RegExp("^(" + pnum + ")(?!px)[a-z%]+$", "i");
  var getStyles = function(elem) {
    if (elem.ownerDocument.defaultView.opener) {
      return elem.ownerDocument.defaultView.getComputedStyle(elem, null);
    }
    return window.getComputedStyle(elem, null);
  };
  function curCSS(elem, name, computed) {
    var width,
        minWidth,
        maxWidth,
        ret,
        style = elem.style;
    computed = computed || getStyles(elem);
    if (computed) {
      ret = computed.getPropertyValue(name) || computed[name];
    }
    if (computed) {
      if (ret === "" && !jQuery.contains(elem.ownerDocument, elem)) {
        ret = jQuery.style(elem, name);
      }
      if (rnumnonpx.test(ret) && rmargin.test(name)) {
        width = style.width;
        minWidth = style.minWidth;
        maxWidth = style.maxWidth;
        style.minWidth = style.maxWidth = style.width = ret;
        ret = computed.width;
        style.width = width;
        style.minWidth = minWidth;
        style.maxWidth = maxWidth;
      }
    }
    return ret !== undefined ? ret + "" : ret;
  }
  function addGetHookIf(conditionFn, hookFn) {
    return {get: function() {
        if (conditionFn()) {
          delete this.get;
          return;
        }
        return (this.get = hookFn).apply(this, arguments);
      }};
  }
  (function() {
    var pixelPositionVal,
        boxSizingReliableVal,
        docElem = document.documentElement,
        container = document.createElement("div"),
        div = document.createElement("div");
    if (!div.style) {
      return;
    }
    div.style.backgroundClip = "content-box";
    div.cloneNode(true).style.backgroundClip = "";
    support.clearCloneStyle = div.style.backgroundClip === "content-box";
    container.style.cssText = "border:0;width:0;height:0;top:0;left:-9999px;margin-top:1px;" + "position:absolute";
    container.appendChild(div);
    function computePixelPositionAndBoxSizingReliable() {
      div.style.cssText = "-webkit-box-sizing:border-box;-moz-box-sizing:border-box;" + "box-sizing:border-box;display:block;margin-top:1%;top:1%;" + "border:1px;padding:1px;width:4px;position:absolute";
      div.innerHTML = "";
      docElem.appendChild(container);
      var divStyle = window.getComputedStyle(div, null);
      pixelPositionVal = divStyle.top !== "1%";
      boxSizingReliableVal = divStyle.width === "4px";
      docElem.removeChild(container);
    }
    if (window.getComputedStyle) {
      jQuery.extend(support, {
        pixelPosition: function() {
          computePixelPositionAndBoxSizingReliable();
          return pixelPositionVal;
        },
        boxSizingReliable: function() {
          if (boxSizingReliableVal == null) {
            computePixelPositionAndBoxSizingReliable();
          }
          return boxSizingReliableVal;
        },
        reliableMarginRight: function() {
          var ret,
              marginDiv = div.appendChild(document.createElement("div"));
          marginDiv.style.cssText = div.style.cssText = "-webkit-box-sizing:content-box;-moz-box-sizing:content-box;" + "box-sizing:content-box;display:block;margin:0;border:0;padding:0";
          marginDiv.style.marginRight = marginDiv.style.width = "0";
          div.style.width = "1px";
          docElem.appendChild(container);
          ret = !parseFloat(window.getComputedStyle(marginDiv, null).marginRight);
          docElem.removeChild(container);
          div.removeChild(marginDiv);
          return ret;
        }
      });
    }
  })();
  jQuery.swap = function(elem, options, callback, args) {
    var ret,
        name,
        old = {};
    for (name in options) {
      old[name] = elem.style[name];
      elem.style[name] = options[name];
    }
    ret = callback.apply(elem, args || []);
    for (name in options) {
      elem.style[name] = old[name];
    }
    return ret;
  };
  var rdisplayswap = /^(none|table(?!-c[ea]).+)/,
      rnumsplit = new RegExp("^(" + pnum + ")(.*)$", "i"),
      rrelNum = new RegExp("^([+-])=(" + pnum + ")", "i"),
      cssShow = {
        position: "absolute",
        visibility: "hidden",
        display: "block"
      },
      cssNormalTransform = {
        letterSpacing: "0",
        fontWeight: "400"
      },
      cssPrefixes = ["Webkit", "O", "Moz", "ms"];
  function vendorPropName(style, name) {
    if (name in style) {
      return name;
    }
    var capName = name[0].toUpperCase() + name.slice(1),
        origName = name,
        i = cssPrefixes.length;
    while (i--) {
      name = cssPrefixes[i] + capName;
      if (name in style) {
        return name;
      }
    }
    return origName;
  }
  function setPositiveNumber(elem, value, subtract) {
    var matches = rnumsplit.exec(value);
    return matches ? Math.max(0, matches[1] - (subtract || 0)) + (matches[2] || "px") : value;
  }
  function augmentWidthOrHeight(elem, name, extra, isBorderBox, styles) {
    var i = extra === (isBorderBox ? "border" : "content") ? 4 : name === "width" ? 1 : 0,
        val = 0;
    for (; i < 4; i += 2) {
      if (extra === "margin") {
        val += jQuery.css(elem, extra + cssExpand[i], true, styles);
      }
      if (isBorderBox) {
        if (extra === "content") {
          val -= jQuery.css(elem, "padding" + cssExpand[i], true, styles);
        }
        if (extra !== "margin") {
          val -= jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
        }
      } else {
        val += jQuery.css(elem, "padding" + cssExpand[i], true, styles);
        if (extra !== "padding") {
          val += jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
        }
      }
    }
    return val;
  }
  function getWidthOrHeight(elem, name, extra) {
    var valueIsBorderBox = true,
        val = name === "width" ? elem.offsetWidth : elem.offsetHeight,
        styles = getStyles(elem),
        isBorderBox = jQuery.css(elem, "boxSizing", false, styles) === "border-box";
    if (val <= 0 || val == null) {
      val = curCSS(elem, name, styles);
      if (val < 0 || val == null) {
        val = elem.style[name];
      }
      if (rnumnonpx.test(val)) {
        return val;
      }
      valueIsBorderBox = isBorderBox && (support.boxSizingReliable() || val === elem.style[name]);
      val = parseFloat(val) || 0;
    }
    return (val + augmentWidthOrHeight(elem, name, extra || (isBorderBox ? "border" : "content"), valueIsBorderBox, styles)) + "px";
  }
  function showHide(elements, show) {
    var display,
        elem,
        hidden,
        values = [],
        index = 0,
        length = elements.length;
    for (; index < length; index++) {
      elem = elements[index];
      if (!elem.style) {
        continue;
      }
      values[index] = data_priv.get(elem, "olddisplay");
      display = elem.style.display;
      if (show) {
        if (!values[index] && display === "none") {
          elem.style.display = "";
        }
        if (elem.style.display === "" && isHidden(elem)) {
          values[index] = data_priv.access(elem, "olddisplay", defaultDisplay(elem.nodeName));
        }
      } else {
        hidden = isHidden(elem);
        if (display !== "none" || !hidden) {
          data_priv.set(elem, "olddisplay", hidden ? display : jQuery.css(elem, "display"));
        }
      }
    }
    for (index = 0; index < length; index++) {
      elem = elements[index];
      if (!elem.style) {
        continue;
      }
      if (!show || elem.style.display === "none" || elem.style.display === "") {
        elem.style.display = show ? values[index] || "" : "none";
      }
    }
    return elements;
  }
  jQuery.extend({
    cssHooks: {opacity: {get: function(elem, computed) {
          if (computed) {
            var ret = curCSS(elem, "opacity");
            return ret === "" ? "1" : ret;
          }
        }}},
    cssNumber: {
      "columnCount": true,
      "fillOpacity": true,
      "flexGrow": true,
      "flexShrink": true,
      "fontWeight": true,
      "lineHeight": true,
      "opacity": true,
      "order": true,
      "orphans": true,
      "widows": true,
      "zIndex": true,
      "zoom": true
    },
    cssProps: {"float": "cssFloat"},
    style: function(elem, name, value, extra) {
      if (!elem || elem.nodeType === 3 || elem.nodeType === 8 || !elem.style) {
        return;
      }
      var ret,
          type,
          hooks,
          origName = jQuery.camelCase(name),
          style = elem.style;
      name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(style, origName));
      hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
      if (value !== undefined) {
        type = typeof value;
        if (type === "string" && (ret = rrelNum.exec(value))) {
          value = (ret[1] + 1) * ret[2] + parseFloat(jQuery.css(elem, name));
          type = "number";
        }
        if (value == null || value !== value) {
          return;
        }
        if (type === "number" && !jQuery.cssNumber[origName]) {
          value += "px";
        }
        if (!support.clearCloneStyle && value === "" && name.indexOf("background") === 0) {
          style[name] = "inherit";
        }
        if (!hooks || !("set" in hooks) || (value = hooks.set(elem, value, extra)) !== undefined) {
          style[name] = value;
        }
      } else {
        if (hooks && "get" in hooks && (ret = hooks.get(elem, false, extra)) !== undefined) {
          return ret;
        }
        return style[name];
      }
    },
    css: function(elem, name, extra, styles) {
      var val,
          num,
          hooks,
          origName = jQuery.camelCase(name);
      name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(elem.style, origName));
      hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
      if (hooks && "get" in hooks) {
        val = hooks.get(elem, true, extra);
      }
      if (val === undefined) {
        val = curCSS(elem, name, styles);
      }
      if (val === "normal" && name in cssNormalTransform) {
        val = cssNormalTransform[name];
      }
      if (extra === "" || extra) {
        num = parseFloat(val);
        return extra === true || jQuery.isNumeric(num) ? num || 0 : val;
      }
      return val;
    }
  });
  jQuery.each(["height", "width"], function(i, name) {
    jQuery.cssHooks[name] = {
      get: function(elem, computed, extra) {
        if (computed) {
          return rdisplayswap.test(jQuery.css(elem, "display")) && elem.offsetWidth === 0 ? jQuery.swap(elem, cssShow, function() {
            return getWidthOrHeight(elem, name, extra);
          }) : getWidthOrHeight(elem, name, extra);
        }
      },
      set: function(elem, value, extra) {
        var styles = extra && getStyles(elem);
        return setPositiveNumber(elem, value, extra ? augmentWidthOrHeight(elem, name, extra, jQuery.css(elem, "boxSizing", false, styles) === "border-box", styles) : 0);
      }
    };
  });
  jQuery.cssHooks.marginRight = addGetHookIf(support.reliableMarginRight, function(elem, computed) {
    if (computed) {
      return jQuery.swap(elem, {"display": "inline-block"}, curCSS, [elem, "marginRight"]);
    }
  });
  jQuery.each({
    margin: "",
    padding: "",
    border: "Width"
  }, function(prefix, suffix) {
    jQuery.cssHooks[prefix + suffix] = {expand: function(value) {
        var i = 0,
            expanded = {},
            parts = typeof value === "string" ? value.split(" ") : [value];
        for (; i < 4; i++) {
          expanded[prefix + cssExpand[i] + suffix] = parts[i] || parts[i - 2] || parts[0];
        }
        return expanded;
      }};
    if (!rmargin.test(prefix)) {
      jQuery.cssHooks[prefix + suffix].set = setPositiveNumber;
    }
  });
  jQuery.fn.extend({
    css: function(name, value) {
      return access(this, function(elem, name, value) {
        var styles,
            len,
            map = {},
            i = 0;
        if (jQuery.isArray(name)) {
          styles = getStyles(elem);
          len = name.length;
          for (; i < len; i++) {
            map[name[i]] = jQuery.css(elem, name[i], false, styles);
          }
          return map;
        }
        return value !== undefined ? jQuery.style(elem, name, value) : jQuery.css(elem, name);
      }, name, value, arguments.length > 1);
    },
    show: function() {
      return showHide(this, true);
    },
    hide: function() {
      return showHide(this);
    },
    toggle: function(state) {
      if (typeof state === "boolean") {
        return state ? this.show() : this.hide();
      }
      return this.each(function() {
        if (isHidden(this)) {
          jQuery(this).show();
        } else {
          jQuery(this).hide();
        }
      });
    }
  });
  function Tween(elem, options, prop, end, easing) {
    return new Tween.prototype.init(elem, options, prop, end, easing);
  }
  jQuery.Tween = Tween;
  Tween.prototype = {
    constructor: Tween,
    init: function(elem, options, prop, end, easing, unit) {
      this.elem = elem;
      this.prop = prop;
      this.easing = easing || "swing";
      this.options = options;
      this.start = this.now = this.cur();
      this.end = end;
      this.unit = unit || (jQuery.cssNumber[prop] ? "" : "px");
    },
    cur: function() {
      var hooks = Tween.propHooks[this.prop];
      return hooks && hooks.get ? hooks.get(this) : Tween.propHooks._default.get(this);
    },
    run: function(percent) {
      var eased,
          hooks = Tween.propHooks[this.prop];
      if (this.options.duration) {
        this.pos = eased = jQuery.easing[this.easing](percent, this.options.duration * percent, 0, 1, this.options.duration);
      } else {
        this.pos = eased = percent;
      }
      this.now = (this.end - this.start) * eased + this.start;
      if (this.options.step) {
        this.options.step.call(this.elem, this.now, this);
      }
      if (hooks && hooks.set) {
        hooks.set(this);
      } else {
        Tween.propHooks._default.set(this);
      }
      return this;
    }
  };
  Tween.prototype.init.prototype = Tween.prototype;
  Tween.propHooks = {_default: {
      get: function(tween) {
        var result;
        if (tween.elem[tween.prop] != null && (!tween.elem.style || tween.elem.style[tween.prop] == null)) {
          return tween.elem[tween.prop];
        }
        result = jQuery.css(tween.elem, tween.prop, "");
        return !result || result === "auto" ? 0 : result;
      },
      set: function(tween) {
        if (jQuery.fx.step[tween.prop]) {
          jQuery.fx.step[tween.prop](tween);
        } else if (tween.elem.style && (tween.elem.style[jQuery.cssProps[tween.prop]] != null || jQuery.cssHooks[tween.prop])) {
          jQuery.style(tween.elem, tween.prop, tween.now + tween.unit);
        } else {
          tween.elem[tween.prop] = tween.now;
        }
      }
    }};
  Tween.propHooks.scrollTop = Tween.propHooks.scrollLeft = {set: function(tween) {
      if (tween.elem.nodeType && tween.elem.parentNode) {
        tween.elem[tween.prop] = tween.now;
      }
    }};
  jQuery.easing = {
    linear: function(p) {
      return p;
    },
    swing: function(p) {
      return 0.5 - Math.cos(p * Math.PI) / 2;
    }
  };
  jQuery.fx = Tween.prototype.init;
  jQuery.fx.step = {};
  var fxNow,
      timerId,
      rfxtypes = /^(?:toggle|show|hide)$/,
      rfxnum = new RegExp("^(?:([+-])=|)(" + pnum + ")([a-z%]*)$", "i"),
      rrun = /queueHooks$/,
      animationPrefilters = [defaultPrefilter],
      tweeners = {"*": [function(prop, value) {
          var tween = this.createTween(prop, value),
              target = tween.cur(),
              parts = rfxnum.exec(value),
              unit = parts && parts[3] || (jQuery.cssNumber[prop] ? "" : "px"),
              start = (jQuery.cssNumber[prop] || unit !== "px" && +target) && rfxnum.exec(jQuery.css(tween.elem, prop)),
              scale = 1,
              maxIterations = 20;
          if (start && start[3] !== unit) {
            unit = unit || start[3];
            parts = parts || [];
            start = +target || 1;
            do {
              scale = scale || ".5";
              start = start / scale;
              jQuery.style(tween.elem, prop, start + unit);
            } while (scale !== (scale = tween.cur() / target) && scale !== 1 && --maxIterations);
          }
          if (parts) {
            start = tween.start = +start || +target || 0;
            tween.unit = unit;
            tween.end = parts[1] ? start + (parts[1] + 1) * parts[2] : +parts[2];
          }
          return tween;
        }]};
  function createFxNow() {
    setTimeout(function() {
      fxNow = undefined;
    });
    return (fxNow = jQuery.now());
  }
  function genFx(type, includeWidth) {
    var which,
        i = 0,
        attrs = {height: type};
    includeWidth = includeWidth ? 1 : 0;
    for (; i < 4; i += 2 - includeWidth) {
      which = cssExpand[i];
      attrs["margin" + which] = attrs["padding" + which] = type;
    }
    if (includeWidth) {
      attrs.opacity = attrs.width = type;
    }
    return attrs;
  }
  function createTween(value, prop, animation) {
    var tween,
        collection = (tweeners[prop] || []).concat(tweeners["*"]),
        index = 0,
        length = collection.length;
    for (; index < length; index++) {
      if ((tween = collection[index].call(animation, prop, value))) {
        return tween;
      }
    }
  }
  function defaultPrefilter(elem, props, opts) {
    var prop,
        value,
        toggle,
        tween,
        hooks,
        oldfire,
        display,
        checkDisplay,
        anim = this,
        orig = {},
        style = elem.style,
        hidden = elem.nodeType && isHidden(elem),
        dataShow = data_priv.get(elem, "fxshow");
    if (!opts.queue) {
      hooks = jQuery._queueHooks(elem, "fx");
      if (hooks.unqueued == null) {
        hooks.unqueued = 0;
        oldfire = hooks.empty.fire;
        hooks.empty.fire = function() {
          if (!hooks.unqueued) {
            oldfire();
          }
        };
      }
      hooks.unqueued++;
      anim.always(function() {
        anim.always(function() {
          hooks.unqueued--;
          if (!jQuery.queue(elem, "fx").length) {
            hooks.empty.fire();
          }
        });
      });
    }
    if (elem.nodeType === 1 && ("height" in props || "width" in props)) {
      opts.overflow = [style.overflow, style.overflowX, style.overflowY];
      display = jQuery.css(elem, "display");
      checkDisplay = display === "none" ? data_priv.get(elem, "olddisplay") || defaultDisplay(elem.nodeName) : display;
      if (checkDisplay === "inline" && jQuery.css(elem, "float") === "none") {
        style.display = "inline-block";
      }
    }
    if (opts.overflow) {
      style.overflow = "hidden";
      anim.always(function() {
        style.overflow = opts.overflow[0];
        style.overflowX = opts.overflow[1];
        style.overflowY = opts.overflow[2];
      });
    }
    for (prop in props) {
      value = props[prop];
      if (rfxtypes.exec(value)) {
        delete props[prop];
        toggle = toggle || value === "toggle";
        if (value === (hidden ? "hide" : "show")) {
          if (value === "show" && dataShow && dataShow[prop] !== undefined) {
            hidden = true;
          } else {
            continue;
          }
        }
        orig[prop] = dataShow && dataShow[prop] || jQuery.style(elem, prop);
      } else {
        display = undefined;
      }
    }
    if (!jQuery.isEmptyObject(orig)) {
      if (dataShow) {
        if ("hidden" in dataShow) {
          hidden = dataShow.hidden;
        }
      } else {
        dataShow = data_priv.access(elem, "fxshow", {});
      }
      if (toggle) {
        dataShow.hidden = !hidden;
      }
      if (hidden) {
        jQuery(elem).show();
      } else {
        anim.done(function() {
          jQuery(elem).hide();
        });
      }
      anim.done(function() {
        var prop;
        data_priv.remove(elem, "fxshow");
        for (prop in orig) {
          jQuery.style(elem, prop, orig[prop]);
        }
      });
      for (prop in orig) {
        tween = createTween(hidden ? dataShow[prop] : 0, prop, anim);
        if (!(prop in dataShow)) {
          dataShow[prop] = tween.start;
          if (hidden) {
            tween.end = tween.start;
            tween.start = prop === "width" || prop === "height" ? 1 : 0;
          }
        }
      }
    } else if ((display === "none" ? defaultDisplay(elem.nodeName) : display) === "inline") {
      style.display = display;
    }
  }
  function propFilter(props, specialEasing) {
    var index,
        name,
        easing,
        value,
        hooks;
    for (index in props) {
      name = jQuery.camelCase(index);
      easing = specialEasing[name];
      value = props[index];
      if (jQuery.isArray(value)) {
        easing = value[1];
        value = props[index] = value[0];
      }
      if (index !== name) {
        props[name] = value;
        delete props[index];
      }
      hooks = jQuery.cssHooks[name];
      if (hooks && "expand" in hooks) {
        value = hooks.expand(value);
        delete props[name];
        for (index in value) {
          if (!(index in props)) {
            props[index] = value[index];
            specialEasing[index] = easing;
          }
        }
      } else {
        specialEasing[name] = easing;
      }
    }
  }
  function Animation(elem, properties, options) {
    var result,
        stopped,
        index = 0,
        length = animationPrefilters.length,
        deferred = jQuery.Deferred().always(function() {
          delete tick.elem;
        }),
        tick = function() {
          if (stopped) {
            return false;
          }
          var currentTime = fxNow || createFxNow(),
              remaining = Math.max(0, animation.startTime + animation.duration - currentTime),
              temp = remaining / animation.duration || 0,
              percent = 1 - temp,
              index = 0,
              length = animation.tweens.length;
          for (; index < length; index++) {
            animation.tweens[index].run(percent);
          }
          deferred.notifyWith(elem, [animation, percent, remaining]);
          if (percent < 1 && length) {
            return remaining;
          } else {
            deferred.resolveWith(elem, [animation]);
            return false;
          }
        },
        animation = deferred.promise({
          elem: elem,
          props: jQuery.extend({}, properties),
          opts: jQuery.extend(true, {specialEasing: {}}, options),
          originalProperties: properties,
          originalOptions: options,
          startTime: fxNow || createFxNow(),
          duration: options.duration,
          tweens: [],
          createTween: function(prop, end) {
            var tween = jQuery.Tween(elem, animation.opts, prop, end, animation.opts.specialEasing[prop] || animation.opts.easing);
            animation.tweens.push(tween);
            return tween;
          },
          stop: function(gotoEnd) {
            var index = 0,
                length = gotoEnd ? animation.tweens.length : 0;
            if (stopped) {
              return this;
            }
            stopped = true;
            for (; index < length; index++) {
              animation.tweens[index].run(1);
            }
            if (gotoEnd) {
              deferred.resolveWith(elem, [animation, gotoEnd]);
            } else {
              deferred.rejectWith(elem, [animation, gotoEnd]);
            }
            return this;
          }
        }),
        props = animation.props;
    propFilter(props, animation.opts.specialEasing);
    for (; index < length; index++) {
      result = animationPrefilters[index].call(animation, elem, props, animation.opts);
      if (result) {
        return result;
      }
    }
    jQuery.map(props, createTween, animation);
    if (jQuery.isFunction(animation.opts.start)) {
      animation.opts.start.call(elem, animation);
    }
    jQuery.fx.timer(jQuery.extend(tick, {
      elem: elem,
      anim: animation,
      queue: animation.opts.queue
    }));
    return animation.progress(animation.opts.progress).done(animation.opts.done, animation.opts.complete).fail(animation.opts.fail).always(animation.opts.always);
  }
  jQuery.Animation = jQuery.extend(Animation, {
    tweener: function(props, callback) {
      if (jQuery.isFunction(props)) {
        callback = props;
        props = ["*"];
      } else {
        props = props.split(" ");
      }
      var prop,
          index = 0,
          length = props.length;
      for (; index < length; index++) {
        prop = props[index];
        tweeners[prop] = tweeners[prop] || [];
        tweeners[prop].unshift(callback);
      }
    },
    prefilter: function(callback, prepend) {
      if (prepend) {
        animationPrefilters.unshift(callback);
      } else {
        animationPrefilters.push(callback);
      }
    }
  });
  jQuery.speed = function(speed, easing, fn) {
    var opt = speed && typeof speed === "object" ? jQuery.extend({}, speed) : {
      complete: fn || !fn && easing || jQuery.isFunction(speed) && speed,
      duration: speed,
      easing: fn && easing || easing && !jQuery.isFunction(easing) && easing
    };
    opt.duration = jQuery.fx.off ? 0 : typeof opt.duration === "number" ? opt.duration : opt.duration in jQuery.fx.speeds ? jQuery.fx.speeds[opt.duration] : jQuery.fx.speeds._default;
    if (opt.queue == null || opt.queue === true) {
      opt.queue = "fx";
    }
    opt.old = opt.complete;
    opt.complete = function() {
      if (jQuery.isFunction(opt.old)) {
        opt.old.call(this);
      }
      if (opt.queue) {
        jQuery.dequeue(this, opt.queue);
      }
    };
    return opt;
  };
  jQuery.fn.extend({
    fadeTo: function(speed, to, easing, callback) {
      return this.filter(isHidden).css("opacity", 0).show().end().animate({opacity: to}, speed, easing, callback);
    },
    animate: function(prop, speed, easing, callback) {
      var empty = jQuery.isEmptyObject(prop),
          optall = jQuery.speed(speed, easing, callback),
          doAnimation = function() {
            var anim = Animation(this, jQuery.extend({}, prop), optall);
            if (empty || data_priv.get(this, "finish")) {
              anim.stop(true);
            }
          };
      doAnimation.finish = doAnimation;
      return empty || optall.queue === false ? this.each(doAnimation) : this.queue(optall.queue, doAnimation);
    },
    stop: function(type, clearQueue, gotoEnd) {
      var stopQueue = function(hooks) {
        var stop = hooks.stop;
        delete hooks.stop;
        stop(gotoEnd);
      };
      if (typeof type !== "string") {
        gotoEnd = clearQueue;
        clearQueue = type;
        type = undefined;
      }
      if (clearQueue && type !== false) {
        this.queue(type || "fx", []);
      }
      return this.each(function() {
        var dequeue = true,
            index = type != null && type + "queueHooks",
            timers = jQuery.timers,
            data = data_priv.get(this);
        if (index) {
          if (data[index] && data[index].stop) {
            stopQueue(data[index]);
          }
        } else {
          for (index in data) {
            if (data[index] && data[index].stop && rrun.test(index)) {
              stopQueue(data[index]);
            }
          }
        }
        for (index = timers.length; index--; ) {
          if (timers[index].elem === this && (type == null || timers[index].queue === type)) {
            timers[index].anim.stop(gotoEnd);
            dequeue = false;
            timers.splice(index, 1);
          }
        }
        if (dequeue || !gotoEnd) {
          jQuery.dequeue(this, type);
        }
      });
    },
    finish: function(type) {
      if (type !== false) {
        type = type || "fx";
      }
      return this.each(function() {
        var index,
            data = data_priv.get(this),
            queue = data[type + "queue"],
            hooks = data[type + "queueHooks"],
            timers = jQuery.timers,
            length = queue ? queue.length : 0;
        data.finish = true;
        jQuery.queue(this, type, []);
        if (hooks && hooks.stop) {
          hooks.stop.call(this, true);
        }
        for (index = timers.length; index--; ) {
          if (timers[index].elem === this && timers[index].queue === type) {
            timers[index].anim.stop(true);
            timers.splice(index, 1);
          }
        }
        for (index = 0; index < length; index++) {
          if (queue[index] && queue[index].finish) {
            queue[index].finish.call(this);
          }
        }
        delete data.finish;
      });
    }
  });
  jQuery.each(["toggle", "show", "hide"], function(i, name) {
    var cssFn = jQuery.fn[name];
    jQuery.fn[name] = function(speed, easing, callback) {
      return speed == null || typeof speed === "boolean" ? cssFn.apply(this, arguments) : this.animate(genFx(name, true), speed, easing, callback);
    };
  });
  jQuery.each({
    slideDown: genFx("show"),
    slideUp: genFx("hide"),
    slideToggle: genFx("toggle"),
    fadeIn: {opacity: "show"},
    fadeOut: {opacity: "hide"},
    fadeToggle: {opacity: "toggle"}
  }, function(name, props) {
    jQuery.fn[name] = function(speed, easing, callback) {
      return this.animate(props, speed, easing, callback);
    };
  });
  jQuery.timers = [];
  jQuery.fx.tick = function() {
    var timer,
        i = 0,
        timers = jQuery.timers;
    fxNow = jQuery.now();
    for (; i < timers.length; i++) {
      timer = timers[i];
      if (!timer() && timers[i] === timer) {
        timers.splice(i--, 1);
      }
    }
    if (!timers.length) {
      jQuery.fx.stop();
    }
    fxNow = undefined;
  };
  jQuery.fx.timer = function(timer) {
    jQuery.timers.push(timer);
    if (timer()) {
      jQuery.fx.start();
    } else {
      jQuery.timers.pop();
    }
  };
  jQuery.fx.interval = 13;
  jQuery.fx.start = function() {
    if (!timerId) {
      timerId = setInterval(jQuery.fx.tick, jQuery.fx.interval);
    }
  };
  jQuery.fx.stop = function() {
    clearInterval(timerId);
    timerId = null;
  };
  jQuery.fx.speeds = {
    slow: 600,
    fast: 200,
    _default: 400
  };
  jQuery.fn.delay = function(time, type) {
    time = jQuery.fx ? jQuery.fx.speeds[time] || time : time;
    type = type || "fx";
    return this.queue(type, function(next, hooks) {
      var timeout = setTimeout(next, time);
      hooks.stop = function() {
        clearTimeout(timeout);
      };
    });
  };
  (function() {
    var input = document.createElement("input"),
        select = document.createElement("select"),
        opt = select.appendChild(document.createElement("option"));
    input.type = "checkbox";
    support.checkOn = input.value !== "";
    support.optSelected = opt.selected;
    select.disabled = true;
    support.optDisabled = !opt.disabled;
    input = document.createElement("input");
    input.value = "t";
    input.type = "radio";
    support.radioValue = input.value === "t";
  })();
  var nodeHook,
      boolHook,
      attrHandle = jQuery.expr.attrHandle;
  jQuery.fn.extend({
    attr: function(name, value) {
      return access(this, jQuery.attr, name, value, arguments.length > 1);
    },
    removeAttr: function(name) {
      return this.each(function() {
        jQuery.removeAttr(this, name);
      });
    }
  });
  jQuery.extend({
    attr: function(elem, name, value) {
      var hooks,
          ret,
          nType = elem.nodeType;
      if (!elem || nType === 3 || nType === 8 || nType === 2) {
        return;
      }
      if (typeof elem.getAttribute === strundefined) {
        return jQuery.prop(elem, name, value);
      }
      if (nType !== 1 || !jQuery.isXMLDoc(elem)) {
        name = name.toLowerCase();
        hooks = jQuery.attrHooks[name] || (jQuery.expr.match.bool.test(name) ? boolHook : nodeHook);
      }
      if (value !== undefined) {
        if (value === null) {
          jQuery.removeAttr(elem, name);
        } else if (hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined) {
          return ret;
        } else {
          elem.setAttribute(name, value + "");
          return value;
        }
      } else if (hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null) {
        return ret;
      } else {
        ret = jQuery.find.attr(elem, name);
        return ret == null ? undefined : ret;
      }
    },
    removeAttr: function(elem, value) {
      var name,
          propName,
          i = 0,
          attrNames = value && value.match(rnotwhite);
      if (attrNames && elem.nodeType === 1) {
        while ((name = attrNames[i++])) {
          propName = jQuery.propFix[name] || name;
          if (jQuery.expr.match.bool.test(name)) {
            elem[propName] = false;
          }
          elem.removeAttribute(name);
        }
      }
    },
    attrHooks: {type: {set: function(elem, value) {
          if (!support.radioValue && value === "radio" && jQuery.nodeName(elem, "input")) {
            var val = elem.value;
            elem.setAttribute("type", value);
            if (val) {
              elem.value = val;
            }
            return value;
          }
        }}}
  });
  boolHook = {set: function(elem, value, name) {
      if (value === false) {
        jQuery.removeAttr(elem, name);
      } else {
        elem.setAttribute(name, name);
      }
      return name;
    }};
  jQuery.each(jQuery.expr.match.bool.source.match(/\w+/g), function(i, name) {
    var getter = attrHandle[name] || jQuery.find.attr;
    attrHandle[name] = function(elem, name, isXML) {
      var ret,
          handle;
      if (!isXML) {
        handle = attrHandle[name];
        attrHandle[name] = ret;
        ret = getter(elem, name, isXML) != null ? name.toLowerCase() : null;
        attrHandle[name] = handle;
      }
      return ret;
    };
  });
  var rfocusable = /^(?:input|select|textarea|button)$/i;
  jQuery.fn.extend({
    prop: function(name, value) {
      return access(this, jQuery.prop, name, value, arguments.length > 1);
    },
    removeProp: function(name) {
      return this.each(function() {
        delete this[jQuery.propFix[name] || name];
      });
    }
  });
  jQuery.extend({
    propFix: {
      "for": "htmlFor",
      "class": "className"
    },
    prop: function(elem, name, value) {
      var ret,
          hooks,
          notxml,
          nType = elem.nodeType;
      if (!elem || nType === 3 || nType === 8 || nType === 2) {
        return;
      }
      notxml = nType !== 1 || !jQuery.isXMLDoc(elem);
      if (notxml) {
        name = jQuery.propFix[name] || name;
        hooks = jQuery.propHooks[name];
      }
      if (value !== undefined) {
        return hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined ? ret : (elem[name] = value);
      } else {
        return hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null ? ret : elem[name];
      }
    },
    propHooks: {tabIndex: {get: function(elem) {
          return elem.hasAttribute("tabindex") || rfocusable.test(elem.nodeName) || elem.href ? elem.tabIndex : -1;
        }}}
  });
  if (!support.optSelected) {
    jQuery.propHooks.selected = {get: function(elem) {
        var parent = elem.parentNode;
        if (parent && parent.parentNode) {
          parent.parentNode.selectedIndex;
        }
        return null;
      }};
  }
  jQuery.each(["tabIndex", "readOnly", "maxLength", "cellSpacing", "cellPadding", "rowSpan", "colSpan", "useMap", "frameBorder", "contentEditable"], function() {
    jQuery.propFix[this.toLowerCase()] = this;
  });
  var rclass = /[\t\r\n\f]/g;
  jQuery.fn.extend({
    addClass: function(value) {
      var classes,
          elem,
          cur,
          clazz,
          j,
          finalValue,
          proceed = typeof value === "string" && value,
          i = 0,
          len = this.length;
      if (jQuery.isFunction(value)) {
        return this.each(function(j) {
          jQuery(this).addClass(value.call(this, j, this.className));
        });
      }
      if (proceed) {
        classes = (value || "").match(rnotwhite) || [];
        for (; i < len; i++) {
          elem = this[i];
          cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : " ");
          if (cur) {
            j = 0;
            while ((clazz = classes[j++])) {
              if (cur.indexOf(" " + clazz + " ") < 0) {
                cur += clazz + " ";
              }
            }
            finalValue = jQuery.trim(cur);
            if (elem.className !== finalValue) {
              elem.className = finalValue;
            }
          }
        }
      }
      return this;
    },
    removeClass: function(value) {
      var classes,
          elem,
          cur,
          clazz,
          j,
          finalValue,
          proceed = arguments.length === 0 || typeof value === "string" && value,
          i = 0,
          len = this.length;
      if (jQuery.isFunction(value)) {
        return this.each(function(j) {
          jQuery(this).removeClass(value.call(this, j, this.className));
        });
      }
      if (proceed) {
        classes = (value || "").match(rnotwhite) || [];
        for (; i < len; i++) {
          elem = this[i];
          cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : "");
          if (cur) {
            j = 0;
            while ((clazz = classes[j++])) {
              while (cur.indexOf(" " + clazz + " ") >= 0) {
                cur = cur.replace(" " + clazz + " ", " ");
              }
            }
            finalValue = value ? jQuery.trim(cur) : "";
            if (elem.className !== finalValue) {
              elem.className = finalValue;
            }
          }
        }
      }
      return this;
    },
    toggleClass: function(value, stateVal) {
      var type = typeof value;
      if (typeof stateVal === "boolean" && type === "string") {
        return stateVal ? this.addClass(value) : this.removeClass(value);
      }
      if (jQuery.isFunction(value)) {
        return this.each(function(i) {
          jQuery(this).toggleClass(value.call(this, i, this.className, stateVal), stateVal);
        });
      }
      return this.each(function() {
        if (type === "string") {
          var className,
              i = 0,
              self = jQuery(this),
              classNames = value.match(rnotwhite) || [];
          while ((className = classNames[i++])) {
            if (self.hasClass(className)) {
              self.removeClass(className);
            } else {
              self.addClass(className);
            }
          }
        } else if (type === strundefined || type === "boolean") {
          if (this.className) {
            data_priv.set(this, "__className__", this.className);
          }
          this.className = this.className || value === false ? "" : data_priv.get(this, "__className__") || "";
        }
      });
    },
    hasClass: function(selector) {
      var className = " " + selector + " ",
          i = 0,
          l = this.length;
      for (; i < l; i++) {
        if (this[i].nodeType === 1 && (" " + this[i].className + " ").replace(rclass, " ").indexOf(className) >= 0) {
          return true;
        }
      }
      return false;
    }
  });
  var rreturn = /\r/g;
  jQuery.fn.extend({val: function(value) {
      var hooks,
          ret,
          isFunction,
          elem = this[0];
      if (!arguments.length) {
        if (elem) {
          hooks = jQuery.valHooks[elem.type] || jQuery.valHooks[elem.nodeName.toLowerCase()];
          if (hooks && "get" in hooks && (ret = hooks.get(elem, "value")) !== undefined) {
            return ret;
          }
          ret = elem.value;
          return typeof ret === "string" ? ret.replace(rreturn, "") : ret == null ? "" : ret;
        }
        return;
      }
      isFunction = jQuery.isFunction(value);
      return this.each(function(i) {
        var val;
        if (this.nodeType !== 1) {
          return;
        }
        if (isFunction) {
          val = value.call(this, i, jQuery(this).val());
        } else {
          val = value;
        }
        if (val == null) {
          val = "";
        } else if (typeof val === "number") {
          val += "";
        } else if (jQuery.isArray(val)) {
          val = jQuery.map(val, function(value) {
            return value == null ? "" : value + "";
          });
        }
        hooks = jQuery.valHooks[this.type] || jQuery.valHooks[this.nodeName.toLowerCase()];
        if (!hooks || !("set" in hooks) || hooks.set(this, val, "value") === undefined) {
          this.value = val;
        }
      });
    }});
  jQuery.extend({valHooks: {
      option: {get: function(elem) {
          var val = jQuery.find.attr(elem, "value");
          return val != null ? val : jQuery.trim(jQuery.text(elem));
        }},
      select: {
        get: function(elem) {
          var value,
              option,
              options = elem.options,
              index = elem.selectedIndex,
              one = elem.type === "select-one" || index < 0,
              values = one ? null : [],
              max = one ? index + 1 : options.length,
              i = index < 0 ? max : one ? index : 0;
          for (; i < max; i++) {
            option = options[i];
            if ((option.selected || i === index) && (support.optDisabled ? !option.disabled : option.getAttribute("disabled") === null) && (!option.parentNode.disabled || !jQuery.nodeName(option.parentNode, "optgroup"))) {
              value = jQuery(option).val();
              if (one) {
                return value;
              }
              values.push(value);
            }
          }
          return values;
        },
        set: function(elem, value) {
          var optionSet,
              option,
              options = elem.options,
              values = jQuery.makeArray(value),
              i = options.length;
          while (i--) {
            option = options[i];
            if ((option.selected = jQuery.inArray(option.value, values) >= 0)) {
              optionSet = true;
            }
          }
          if (!optionSet) {
            elem.selectedIndex = -1;
          }
          return values;
        }
      }
    }});
  jQuery.each(["radio", "checkbox"], function() {
    jQuery.valHooks[this] = {set: function(elem, value) {
        if (jQuery.isArray(value)) {
          return (elem.checked = jQuery.inArray(jQuery(elem).val(), value) >= 0);
        }
      }};
    if (!support.checkOn) {
      jQuery.valHooks[this].get = function(elem) {
        return elem.getAttribute("value") === null ? "on" : elem.value;
      };
    }
  });
  jQuery.each(("blur focus focusin focusout load resize scroll unload click dblclick " + "mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave " + "change select submit keydown keypress keyup error contextmenu").split(" "), function(i, name) {
    jQuery.fn[name] = function(data, fn) {
      return arguments.length > 0 ? this.on(name, null, data, fn) : this.trigger(name);
    };
  });
  jQuery.fn.extend({
    hover: function(fnOver, fnOut) {
      return this.mouseenter(fnOver).mouseleave(fnOut || fnOver);
    },
    bind: function(types, data, fn) {
      return this.on(types, null, data, fn);
    },
    unbind: function(types, fn) {
      return this.off(types, null, fn);
    },
    delegate: function(selector, types, data, fn) {
      return this.on(types, selector, data, fn);
    },
    undelegate: function(selector, types, fn) {
      return arguments.length === 1 ? this.off(selector, "**") : this.off(types, selector || "**", fn);
    }
  });
  var nonce = jQuery.now();
  var rquery = (/\?/);
  jQuery.parseJSON = function(data) {
    return JSON.parse(data + "");
  };
  jQuery.parseXML = function(data) {
    var xml,
        tmp;
    if (!data || typeof data !== "string") {
      return null;
    }
    try {
      tmp = new DOMParser();
      xml = tmp.parseFromString(data, "text/xml");
    } catch (e) {
      xml = undefined;
    }
    if (!xml || xml.getElementsByTagName("parsererror").length) {
      jQuery.error("Invalid XML: " + data);
    }
    return xml;
  };
  var rhash = /#.*$/,
      rts = /([?&])_=[^&]*/,
      rheaders = /^(.*?):[ \t]*([^\r\n]*)$/mg,
      rlocalProtocol = /^(?:about|app|app-storage|.+-extension|file|res|widget):$/,
      rnoContent = /^(?:GET|HEAD)$/,
      rprotocol = /^\/\//,
      rurl = /^([\w.+-]+:)(?:\/\/(?:[^\/?#]*@|)([^\/?#:]*)(?::(\d+)|)|)/,
      prefilters = {},
      transports = {},
      allTypes = "*/".concat("*"),
      ajaxLocation = window.location.href,
      ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || [];
  function addToPrefiltersOrTransports(structure) {
    return function(dataTypeExpression, func) {
      if (typeof dataTypeExpression !== "string") {
        func = dataTypeExpression;
        dataTypeExpression = "*";
      }
      var dataType,
          i = 0,
          dataTypes = dataTypeExpression.toLowerCase().match(rnotwhite) || [];
      if (jQuery.isFunction(func)) {
        while ((dataType = dataTypes[i++])) {
          if (dataType[0] === "+") {
            dataType = dataType.slice(1) || "*";
            (structure[dataType] = structure[dataType] || []).unshift(func);
          } else {
            (structure[dataType] = structure[dataType] || []).push(func);
          }
        }
      }
    };
  }
  function inspectPrefiltersOrTransports(structure, options, originalOptions, jqXHR) {
    var inspected = {},
        seekingTransport = (structure === transports);
    function inspect(dataType) {
      var selected;
      inspected[dataType] = true;
      jQuery.each(structure[dataType] || [], function(_, prefilterOrFactory) {
        var dataTypeOrTransport = prefilterOrFactory(options, originalOptions, jqXHR);
        if (typeof dataTypeOrTransport === "string" && !seekingTransport && !inspected[dataTypeOrTransport]) {
          options.dataTypes.unshift(dataTypeOrTransport);
          inspect(dataTypeOrTransport);
          return false;
        } else if (seekingTransport) {
          return !(selected = dataTypeOrTransport);
        }
      });
      return selected;
    }
    return inspect(options.dataTypes[0]) || !inspected["*"] && inspect("*");
  }
  function ajaxExtend(target, src) {
    var key,
        deep,
        flatOptions = jQuery.ajaxSettings.flatOptions || {};
    for (key in src) {
      if (src[key] !== undefined) {
        (flatOptions[key] ? target : (deep || (deep = {})))[key] = src[key];
      }
    }
    if (deep) {
      jQuery.extend(true, target, deep);
    }
    return target;
  }
  function ajaxHandleResponses(s, jqXHR, responses) {
    var ct,
        type,
        finalDataType,
        firstDataType,
        contents = s.contents,
        dataTypes = s.dataTypes;
    while (dataTypes[0] === "*") {
      dataTypes.shift();
      if (ct === undefined) {
        ct = s.mimeType || jqXHR.getResponseHeader("Content-Type");
      }
    }
    if (ct) {
      for (type in contents) {
        if (contents[type] && contents[type].test(ct)) {
          dataTypes.unshift(type);
          break;
        }
      }
    }
    if (dataTypes[0] in responses) {
      finalDataType = dataTypes[0];
    } else {
      for (type in responses) {
        if (!dataTypes[0] || s.converters[type + " " + dataTypes[0]]) {
          finalDataType = type;
          break;
        }
        if (!firstDataType) {
          firstDataType = type;
        }
      }
      finalDataType = finalDataType || firstDataType;
    }
    if (finalDataType) {
      if (finalDataType !== dataTypes[0]) {
        dataTypes.unshift(finalDataType);
      }
      return responses[finalDataType];
    }
  }
  function ajaxConvert(s, response, jqXHR, isSuccess) {
    var conv2,
        current,
        conv,
        tmp,
        prev,
        converters = {},
        dataTypes = s.dataTypes.slice();
    if (dataTypes[1]) {
      for (conv in s.converters) {
        converters[conv.toLowerCase()] = s.converters[conv];
      }
    }
    current = dataTypes.shift();
    while (current) {
      if (s.responseFields[current]) {
        jqXHR[s.responseFields[current]] = response;
      }
      if (!prev && isSuccess && s.dataFilter) {
        response = s.dataFilter(response, s.dataType);
      }
      prev = current;
      current = dataTypes.shift();
      if (current) {
        if (current === "*") {
          current = prev;
        } else if (prev !== "*" && prev !== current) {
          conv = converters[prev + " " + current] || converters["* " + current];
          if (!conv) {
            for (conv2 in converters) {
              tmp = conv2.split(" ");
              if (tmp[1] === current) {
                conv = converters[prev + " " + tmp[0]] || converters["* " + tmp[0]];
                if (conv) {
                  if (conv === true) {
                    conv = converters[conv2];
                  } else if (converters[conv2] !== true) {
                    current = tmp[0];
                    dataTypes.unshift(tmp[1]);
                  }
                  break;
                }
              }
            }
          }
          if (conv !== true) {
            if (conv && s["throws"]) {
              response = conv(response);
            } else {
              try {
                response = conv(response);
              } catch (e) {
                return {
                  state: "parsererror",
                  error: conv ? e : "No conversion from " + prev + " to " + current
                };
              }
            }
          }
        }
      }
    }
    return {
      state: "success",
      data: response
    };
  }
  jQuery.extend({
    active: 0,
    lastModified: {},
    etag: {},
    ajaxSettings: {
      url: ajaxLocation,
      type: "GET",
      isLocal: rlocalProtocol.test(ajaxLocParts[1]),
      global: true,
      processData: true,
      async: true,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      accepts: {
        "*": allTypes,
        text: "text/plain",
        html: "text/html",
        xml: "application/xml, text/xml",
        json: "application/json, text/javascript"
      },
      contents: {
        xml: /xml/,
        html: /html/,
        json: /json/
      },
      responseFields: {
        xml: "responseXML",
        text: "responseText",
        json: "responseJSON"
      },
      converters: {
        "* text": String,
        "text html": true,
        "text json": jQuery.parseJSON,
        "text xml": jQuery.parseXML
      },
      flatOptions: {
        url: true,
        context: true
      }
    },
    ajaxSetup: function(target, settings) {
      return settings ? ajaxExtend(ajaxExtend(target, jQuery.ajaxSettings), settings) : ajaxExtend(jQuery.ajaxSettings, target);
    },
    ajaxPrefilter: addToPrefiltersOrTransports(prefilters),
    ajaxTransport: addToPrefiltersOrTransports(transports),
    ajax: function(url, options) {
      if (typeof url === "object") {
        options = url;
        url = undefined;
      }
      options = options || {};
      var transport,
          cacheURL,
          responseHeadersString,
          responseHeaders,
          timeoutTimer,
          parts,
          fireGlobals,
          i,
          s = jQuery.ajaxSetup({}, options),
          callbackContext = s.context || s,
          globalEventContext = s.context && (callbackContext.nodeType || callbackContext.jquery) ? jQuery(callbackContext) : jQuery.event,
          deferred = jQuery.Deferred(),
          completeDeferred = jQuery.Callbacks("once memory"),
          statusCode = s.statusCode || {},
          requestHeaders = {},
          requestHeadersNames = {},
          state = 0,
          strAbort = "canceled",
          jqXHR = {
            readyState: 0,
            getResponseHeader: function(key) {
              var match;
              if (state === 2) {
                if (!responseHeaders) {
                  responseHeaders = {};
                  while ((match = rheaders.exec(responseHeadersString))) {
                    responseHeaders[match[1].toLowerCase()] = match[2];
                  }
                }
                match = responseHeaders[key.toLowerCase()];
              }
              return match == null ? null : match;
            },
            getAllResponseHeaders: function() {
              return state === 2 ? responseHeadersString : null;
            },
            setRequestHeader: function(name, value) {
              var lname = name.toLowerCase();
              if (!state) {
                name = requestHeadersNames[lname] = requestHeadersNames[lname] || name;
                requestHeaders[name] = value;
              }
              return this;
            },
            overrideMimeType: function(type) {
              if (!state) {
                s.mimeType = type;
              }
              return this;
            },
            statusCode: function(map) {
              var code;
              if (map) {
                if (state < 2) {
                  for (code in map) {
                    statusCode[code] = [statusCode[code], map[code]];
                  }
                } else {
                  jqXHR.always(map[jqXHR.status]);
                }
              }
              return this;
            },
            abort: function(statusText) {
              var finalText = statusText || strAbort;
              if (transport) {
                transport.abort(finalText);
              }
              done(0, finalText);
              return this;
            }
          };
      deferred.promise(jqXHR).complete = completeDeferred.add;
      jqXHR.success = jqXHR.done;
      jqXHR.error = jqXHR.fail;
      s.url = ((url || s.url || ajaxLocation) + "").replace(rhash, "").replace(rprotocol, ajaxLocParts[1] + "//");
      s.type = options.method || options.type || s.method || s.type;
      s.dataTypes = jQuery.trim(s.dataType || "*").toLowerCase().match(rnotwhite) || [""];
      if (s.crossDomain == null) {
        parts = rurl.exec(s.url.toLowerCase());
        s.crossDomain = !!(parts && (parts[1] !== ajaxLocParts[1] || parts[2] !== ajaxLocParts[2] || (parts[3] || (parts[1] === "http:" ? "80" : "443")) !== (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? "80" : "443"))));
      }
      if (s.data && s.processData && typeof s.data !== "string") {
        s.data = jQuery.param(s.data, s.traditional);
      }
      inspectPrefiltersOrTransports(prefilters, s, options, jqXHR);
      if (state === 2) {
        return jqXHR;
      }
      fireGlobals = jQuery.event && s.global;
      if (fireGlobals && jQuery.active++ === 0) {
        jQuery.event.trigger("ajaxStart");
      }
      s.type = s.type.toUpperCase();
      s.hasContent = !rnoContent.test(s.type);
      cacheURL = s.url;
      if (!s.hasContent) {
        if (s.data) {
          cacheURL = (s.url += (rquery.test(cacheURL) ? "&" : "?") + s.data);
          delete s.data;
        }
        if (s.cache === false) {
          s.url = rts.test(cacheURL) ? cacheURL.replace(rts, "$1_=" + nonce++) : cacheURL + (rquery.test(cacheURL) ? "&" : "?") + "_=" + nonce++;
        }
      }
      if (s.ifModified) {
        if (jQuery.lastModified[cacheURL]) {
          jqXHR.setRequestHeader("If-Modified-Since", jQuery.lastModified[cacheURL]);
        }
        if (jQuery.etag[cacheURL]) {
          jqXHR.setRequestHeader("If-None-Match", jQuery.etag[cacheURL]);
        }
      }
      if (s.data && s.hasContent && s.contentType !== false || options.contentType) {
        jqXHR.setRequestHeader("Content-Type", s.contentType);
      }
      jqXHR.setRequestHeader("Accept", s.dataTypes[0] && s.accepts[s.dataTypes[0]] ? s.accepts[s.dataTypes[0]] + (s.dataTypes[0] !== "*" ? ", " + allTypes + "; q=0.01" : "") : s.accepts["*"]);
      for (i in s.headers) {
        jqXHR.setRequestHeader(i, s.headers[i]);
      }
      if (s.beforeSend && (s.beforeSend.call(callbackContext, jqXHR, s) === false || state === 2)) {
        return jqXHR.abort();
      }
      strAbort = "abort";
      for (i in {
        success: 1,
        error: 1,
        complete: 1
      }) {
        jqXHR[i](s[i]);
      }
      transport = inspectPrefiltersOrTransports(transports, s, options, jqXHR);
      if (!transport) {
        done(-1, "No Transport");
      } else {
        jqXHR.readyState = 1;
        if (fireGlobals) {
          globalEventContext.trigger("ajaxSend", [jqXHR, s]);
        }
        if (s.async && s.timeout > 0) {
          timeoutTimer = setTimeout(function() {
            jqXHR.abort("timeout");
          }, s.timeout);
        }
        try {
          state = 1;
          transport.send(requestHeaders, done);
        } catch (e) {
          if (state < 2) {
            done(-1, e);
          } else {
            throw e;
          }
        }
      }
      function done(status, nativeStatusText, responses, headers) {
        var isSuccess,
            success,
            error,
            response,
            modified,
            statusText = nativeStatusText;
        if (state === 2) {
          return;
        }
        state = 2;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        transport = undefined;
        responseHeadersString = headers || "";
        jqXHR.readyState = status > 0 ? 4 : 0;
        isSuccess = status >= 200 && status < 300 || status === 304;
        if (responses) {
          response = ajaxHandleResponses(s, jqXHR, responses);
        }
        response = ajaxConvert(s, response, jqXHR, isSuccess);
        if (isSuccess) {
          if (s.ifModified) {
            modified = jqXHR.getResponseHeader("Last-Modified");
            if (modified) {
              jQuery.lastModified[cacheURL] = modified;
            }
            modified = jqXHR.getResponseHeader("etag");
            if (modified) {
              jQuery.etag[cacheURL] = modified;
            }
          }
          if (status === 204 || s.type === "HEAD") {
            statusText = "nocontent";
          } else if (status === 304) {
            statusText = "notmodified";
          } else {
            statusText = response.state;
            success = response.data;
            error = response.error;
            isSuccess = !error;
          }
        } else {
          error = statusText;
          if (status || !statusText) {
            statusText = "error";
            if (status < 0) {
              status = 0;
            }
          }
        }
        jqXHR.status = status;
        jqXHR.statusText = (nativeStatusText || statusText) + "";
        if (isSuccess) {
          deferred.resolveWith(callbackContext, [success, statusText, jqXHR]);
        } else {
          deferred.rejectWith(callbackContext, [jqXHR, statusText, error]);
        }
        jqXHR.statusCode(statusCode);
        statusCode = undefined;
        if (fireGlobals) {
          globalEventContext.trigger(isSuccess ? "ajaxSuccess" : "ajaxError", [jqXHR, s, isSuccess ? success : error]);
        }
        completeDeferred.fireWith(callbackContext, [jqXHR, statusText]);
        if (fireGlobals) {
          globalEventContext.trigger("ajaxComplete", [jqXHR, s]);
          if (!(--jQuery.active)) {
            jQuery.event.trigger("ajaxStop");
          }
        }
      }
      return jqXHR;
    },
    getJSON: function(url, data, callback) {
      return jQuery.get(url, data, callback, "json");
    },
    getScript: function(url, callback) {
      return jQuery.get(url, undefined, callback, "script");
    }
  });
  jQuery.each(["get", "post"], function(i, method) {
    jQuery[method] = function(url, data, callback, type) {
      if (jQuery.isFunction(data)) {
        type = type || callback;
        callback = data;
        data = undefined;
      }
      return jQuery.ajax({
        url: url,
        type: method,
        dataType: type,
        data: data,
        success: callback
      });
    };
  });
  jQuery._evalUrl = function(url) {
    return jQuery.ajax({
      url: url,
      type: "GET",
      dataType: "script",
      async: false,
      global: false,
      "throws": true
    });
  };
  jQuery.fn.extend({
    wrapAll: function(html) {
      var wrap;
      if (jQuery.isFunction(html)) {
        return this.each(function(i) {
          jQuery(this).wrapAll(html.call(this, i));
        });
      }
      if (this[0]) {
        wrap = jQuery(html, this[0].ownerDocument).eq(0).clone(true);
        if (this[0].parentNode) {
          wrap.insertBefore(this[0]);
        }
        wrap.map(function() {
          var elem = this;
          while (elem.firstElementChild) {
            elem = elem.firstElementChild;
          }
          return elem;
        }).append(this);
      }
      return this;
    },
    wrapInner: function(html) {
      if (jQuery.isFunction(html)) {
        return this.each(function(i) {
          jQuery(this).wrapInner(html.call(this, i));
        });
      }
      return this.each(function() {
        var self = jQuery(this),
            contents = self.contents();
        if (contents.length) {
          contents.wrapAll(html);
        } else {
          self.append(html);
        }
      });
    },
    wrap: function(html) {
      var isFunction = jQuery.isFunction(html);
      return this.each(function(i) {
        jQuery(this).wrapAll(isFunction ? html.call(this, i) : html);
      });
    },
    unwrap: function() {
      return this.parent().each(function() {
        if (!jQuery.nodeName(this, "body")) {
          jQuery(this).replaceWith(this.childNodes);
        }
      }).end();
    }
  });
  jQuery.expr.filters.hidden = function(elem) {
    return elem.offsetWidth <= 0 && elem.offsetHeight <= 0;
  };
  jQuery.expr.filters.visible = function(elem) {
    return !jQuery.expr.filters.hidden(elem);
  };
  var r20 = /%20/g,
      rbracket = /\[\]$/,
      rCRLF = /\r?\n/g,
      rsubmitterTypes = /^(?:submit|button|image|reset|file)$/i,
      rsubmittable = /^(?:input|select|textarea|keygen)/i;
  function buildParams(prefix, obj, traditional, add) {
    var name;
    if (jQuery.isArray(obj)) {
      jQuery.each(obj, function(i, v) {
        if (traditional || rbracket.test(prefix)) {
          add(prefix, v);
        } else {
          buildParams(prefix + "[" + (typeof v === "object" ? i : "") + "]", v, traditional, add);
        }
      });
    } else if (!traditional && jQuery.type(obj) === "object") {
      for (name in obj) {
        buildParams(prefix + "[" + name + "]", obj[name], traditional, add);
      }
    } else {
      add(prefix, obj);
    }
  }
  jQuery.param = function(a, traditional) {
    var prefix,
        s = [],
        add = function(key, value) {
          value = jQuery.isFunction(value) ? value() : (value == null ? "" : value);
          s[s.length] = encodeURIComponent(key) + "=" + encodeURIComponent(value);
        };
    if (traditional === undefined) {
      traditional = jQuery.ajaxSettings && jQuery.ajaxSettings.traditional;
    }
    if (jQuery.isArray(a) || (a.jquery && !jQuery.isPlainObject(a))) {
      jQuery.each(a, function() {
        add(this.name, this.value);
      });
    } else {
      for (prefix in a) {
        buildParams(prefix, a[prefix], traditional, add);
      }
    }
    return s.join("&").replace(r20, "+");
  };
  jQuery.fn.extend({
    serialize: function() {
      return jQuery.param(this.serializeArray());
    },
    serializeArray: function() {
      return this.map(function() {
        var elements = jQuery.prop(this, "elements");
        return elements ? jQuery.makeArray(elements) : this;
      }).filter(function() {
        var type = this.type;
        return this.name && !jQuery(this).is(":disabled") && rsubmittable.test(this.nodeName) && !rsubmitterTypes.test(type) && (this.checked || !rcheckableType.test(type));
      }).map(function(i, elem) {
        var val = jQuery(this).val();
        return val == null ? null : jQuery.isArray(val) ? jQuery.map(val, function(val) {
          return {
            name: elem.name,
            value: val.replace(rCRLF, "\r\n")
          };
        }) : {
          name: elem.name,
          value: val.replace(rCRLF, "\r\n")
        };
      }).get();
    }
  });
  jQuery.ajaxSettings.xhr = function() {
    try {
      return new XMLHttpRequest();
    } catch (e) {}
  };
  var xhrId = 0,
      xhrCallbacks = {},
      xhrSuccessStatus = {
        0: 200,
        1223: 204
      },
      xhrSupported = jQuery.ajaxSettings.xhr();
  if (window.attachEvent) {
    window.attachEvent("onunload", function() {
      for (var key in xhrCallbacks) {
        xhrCallbacks[key]();
      }
    });
  }
  support.cors = !!xhrSupported && ("withCredentials" in xhrSupported);
  support.ajax = xhrSupported = !!xhrSupported;
  jQuery.ajaxTransport(function(options) {
    var callback;
    if (support.cors || xhrSupported && !options.crossDomain) {
      return {
        send: function(headers, complete) {
          var i,
              xhr = options.xhr(),
              id = ++xhrId;
          xhr.open(options.type, options.url, options.async, options.username, options.password);
          if (options.xhrFields) {
            for (i in options.xhrFields) {
              xhr[i] = options.xhrFields[i];
            }
          }
          if (options.mimeType && xhr.overrideMimeType) {
            xhr.overrideMimeType(options.mimeType);
          }
          if (!options.crossDomain && !headers["X-Requested-With"]) {
            headers["X-Requested-With"] = "XMLHttpRequest";
          }
          for (i in headers) {
            xhr.setRequestHeader(i, headers[i]);
          }
          callback = function(type) {
            return function() {
              if (callback) {
                delete xhrCallbacks[id];
                callback = xhr.onload = xhr.onerror = null;
                if (type === "abort") {
                  xhr.abort();
                } else if (type === "error") {
                  complete(xhr.status, xhr.statusText);
                } else {
                  complete(xhrSuccessStatus[xhr.status] || xhr.status, xhr.statusText, typeof xhr.responseText === "string" ? {text: xhr.responseText} : undefined, xhr.getAllResponseHeaders());
                }
              }
            };
          };
          xhr.onload = callback();
          xhr.onerror = callback("error");
          callback = xhrCallbacks[id] = callback("abort");
          try {
            xhr.send(options.hasContent && options.data || null);
          } catch (e) {
            if (callback) {
              throw e;
            }
          }
        },
        abort: function() {
          if (callback) {
            callback();
          }
        }
      };
    }
  });
  jQuery.ajaxSetup({
    accepts: {script: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"},
    contents: {script: /(?:java|ecma)script/},
    converters: {"text script": function(text) {
        jQuery.globalEval(text);
        return text;
      }}
  });
  jQuery.ajaxPrefilter("script", function(s) {
    if (s.cache === undefined) {
      s.cache = false;
    }
    if (s.crossDomain) {
      s.type = "GET";
    }
  });
  jQuery.ajaxTransport("script", function(s) {
    if (s.crossDomain) {
      var script,
          callback;
      return {
        send: function(_, complete) {
          script = jQuery("<script>").prop({
            async: true,
            charset: s.scriptCharset,
            src: s.url
          }).on("load error", callback = function(evt) {
            script.remove();
            callback = null;
            if (evt) {
              complete(evt.type === "error" ? 404 : 200, evt.type);
            }
          });
          document.head.appendChild(script[0]);
        },
        abort: function() {
          if (callback) {
            callback();
          }
        }
      };
    }
  });
  var oldCallbacks = [],
      rjsonp = /(=)\?(?=&|$)|\?\?/;
  jQuery.ajaxSetup({
    jsonp: "callback",
    jsonpCallback: function() {
      var callback = oldCallbacks.pop() || (jQuery.expando + "_" + (nonce++));
      this[callback] = true;
      return callback;
    }
  });
  jQuery.ajaxPrefilter("json jsonp", function(s, originalSettings, jqXHR) {
    var callbackName,
        overwritten,
        responseContainer,
        jsonProp = s.jsonp !== false && (rjsonp.test(s.url) ? "url" : typeof s.data === "string" && !(s.contentType || "").indexOf("application/x-www-form-urlencoded") && rjsonp.test(s.data) && "data");
    if (jsonProp || s.dataTypes[0] === "jsonp") {
      callbackName = s.jsonpCallback = jQuery.isFunction(s.jsonpCallback) ? s.jsonpCallback() : s.jsonpCallback;
      if (jsonProp) {
        s[jsonProp] = s[jsonProp].replace(rjsonp, "$1" + callbackName);
      } else if (s.jsonp !== false) {
        s.url += (rquery.test(s.url) ? "&" : "?") + s.jsonp + "=" + callbackName;
      }
      s.converters["script json"] = function() {
        if (!responseContainer) {
          jQuery.error(callbackName + " was not called");
        }
        return responseContainer[0];
      };
      s.dataTypes[0] = "json";
      overwritten = window[callbackName];
      window[callbackName] = function() {
        responseContainer = arguments;
      };
      jqXHR.always(function() {
        window[callbackName] = overwritten;
        if (s[callbackName]) {
          s.jsonpCallback = originalSettings.jsonpCallback;
          oldCallbacks.push(callbackName);
        }
        if (responseContainer && jQuery.isFunction(overwritten)) {
          overwritten(responseContainer[0]);
        }
        responseContainer = overwritten = undefined;
      });
      return "script";
    }
  });
  jQuery.parseHTML = function(data, context, keepScripts) {
    if (!data || typeof data !== "string") {
      return null;
    }
    if (typeof context === "boolean") {
      keepScripts = context;
      context = false;
    }
    context = context || document;
    var parsed = rsingleTag.exec(data),
        scripts = !keepScripts && [];
    if (parsed) {
      return [context.createElement(parsed[1])];
    }
    parsed = jQuery.buildFragment([data], context, scripts);
    if (scripts && scripts.length) {
      jQuery(scripts).remove();
    }
    return jQuery.merge([], parsed.childNodes);
  };
  var _load = jQuery.fn.load;
  jQuery.fn.load = function(url, params, callback) {
    if (typeof url !== "string" && _load) {
      return _load.apply(this, arguments);
    }
    var selector,
        type,
        response,
        self = this,
        off = url.indexOf(" ");
    if (off >= 0) {
      selector = jQuery.trim(url.slice(off));
      url = url.slice(0, off);
    }
    if (jQuery.isFunction(params)) {
      callback = params;
      params = undefined;
    } else if (params && typeof params === "object") {
      type = "POST";
    }
    if (self.length > 0) {
      jQuery.ajax({
        url: url,
        type: type,
        dataType: "html",
        data: params
      }).done(function(responseText) {
        response = arguments;
        self.html(selector ? jQuery("<div>").append(jQuery.parseHTML(responseText)).find(selector) : responseText);
      }).complete(callback && function(jqXHR, status) {
        self.each(callback, response || [jqXHR.responseText, status, jqXHR]);
      });
    }
    return this;
  };
  jQuery.each(["ajaxStart", "ajaxStop", "ajaxComplete", "ajaxError", "ajaxSuccess", "ajaxSend"], function(i, type) {
    jQuery.fn[type] = function(fn) {
      return this.on(type, fn);
    };
  });
  jQuery.expr.filters.animated = function(elem) {
    return jQuery.grep(jQuery.timers, function(fn) {
      return elem === fn.elem;
    }).length;
  };
  var docElem = window.document.documentElement;
  function getWindow(elem) {
    return jQuery.isWindow(elem) ? elem : elem.nodeType === 9 && elem.defaultView;
  }
  jQuery.offset = {setOffset: function(elem, options, i) {
      var curPosition,
          curLeft,
          curCSSTop,
          curTop,
          curOffset,
          curCSSLeft,
          calculatePosition,
          position = jQuery.css(elem, "position"),
          curElem = jQuery(elem),
          props = {};
      if (position === "static") {
        elem.style.position = "relative";
      }
      curOffset = curElem.offset();
      curCSSTop = jQuery.css(elem, "top");
      curCSSLeft = jQuery.css(elem, "left");
      calculatePosition = (position === "absolute" || position === "fixed") && (curCSSTop + curCSSLeft).indexOf("auto") > -1;
      if (calculatePosition) {
        curPosition = curElem.position();
        curTop = curPosition.top;
        curLeft = curPosition.left;
      } else {
        curTop = parseFloat(curCSSTop) || 0;
        curLeft = parseFloat(curCSSLeft) || 0;
      }
      if (jQuery.isFunction(options)) {
        options = options.call(elem, i, curOffset);
      }
      if (options.top != null) {
        props.top = (options.top - curOffset.top) + curTop;
      }
      if (options.left != null) {
        props.left = (options.left - curOffset.left) + curLeft;
      }
      if ("using" in options) {
        options.using.call(elem, props);
      } else {
        curElem.css(props);
      }
    }};
  jQuery.fn.extend({
    offset: function(options) {
      if (arguments.length) {
        return options === undefined ? this : this.each(function(i) {
          jQuery.offset.setOffset(this, options, i);
        });
      }
      var docElem,
          win,
          elem = this[0],
          box = {
            top: 0,
            left: 0
          },
          doc = elem && elem.ownerDocument;
      if (!doc) {
        return;
      }
      docElem = doc.documentElement;
      if (!jQuery.contains(docElem, elem)) {
        return box;
      }
      if (typeof elem.getBoundingClientRect !== strundefined) {
        box = elem.getBoundingClientRect();
      }
      win = getWindow(doc);
      return {
        top: box.top + win.pageYOffset - docElem.clientTop,
        left: box.left + win.pageXOffset - docElem.clientLeft
      };
    },
    position: function() {
      if (!this[0]) {
        return;
      }
      var offsetParent,
          offset,
          elem = this[0],
          parentOffset = {
            top: 0,
            left: 0
          };
      if (jQuery.css(elem, "position") === "fixed") {
        offset = elem.getBoundingClientRect();
      } else {
        offsetParent = this.offsetParent();
        offset = this.offset();
        if (!jQuery.nodeName(offsetParent[0], "html")) {
          parentOffset = offsetParent.offset();
        }
        parentOffset.top += jQuery.css(offsetParent[0], "borderTopWidth", true);
        parentOffset.left += jQuery.css(offsetParent[0], "borderLeftWidth", true);
      }
      return {
        top: offset.top - parentOffset.top - jQuery.css(elem, "marginTop", true),
        left: offset.left - parentOffset.left - jQuery.css(elem, "marginLeft", true)
      };
    },
    offsetParent: function() {
      return this.map(function() {
        var offsetParent = this.offsetParent || docElem;
        while (offsetParent && (!jQuery.nodeName(offsetParent, "html") && jQuery.css(offsetParent, "position") === "static")) {
          offsetParent = offsetParent.offsetParent;
        }
        return offsetParent || docElem;
      });
    }
  });
  jQuery.each({
    scrollLeft: "pageXOffset",
    scrollTop: "pageYOffset"
  }, function(method, prop) {
    var top = "pageYOffset" === prop;
    jQuery.fn[method] = function(val) {
      return access(this, function(elem, method, val) {
        var win = getWindow(elem);
        if (val === undefined) {
          return win ? win[prop] : elem[method];
        }
        if (win) {
          win.scrollTo(!top ? val : window.pageXOffset, top ? val : window.pageYOffset);
        } else {
          elem[method] = val;
        }
      }, method, val, arguments.length, null);
    };
  });
  jQuery.each(["top", "left"], function(i, prop) {
    jQuery.cssHooks[prop] = addGetHookIf(support.pixelPosition, function(elem, computed) {
      if (computed) {
        computed = curCSS(elem, prop);
        return rnumnonpx.test(computed) ? jQuery(elem).position()[prop] + "px" : computed;
      }
    });
  });
  jQuery.each({
    Height: "height",
    Width: "width"
  }, function(name, type) {
    jQuery.each({
      padding: "inner" + name,
      content: type,
      "": "outer" + name
    }, function(defaultExtra, funcName) {
      jQuery.fn[funcName] = function(margin, value) {
        var chainable = arguments.length && (defaultExtra || typeof margin !== "boolean"),
            extra = defaultExtra || (margin === true || value === true ? "margin" : "border");
        return access(this, function(elem, type, value) {
          var doc;
          if (jQuery.isWindow(elem)) {
            return elem.document.documentElement["client" + name];
          }
          if (elem.nodeType === 9) {
            doc = elem.documentElement;
            return Math.max(elem.body["scroll" + name], doc["scroll" + name], elem.body["offset" + name], doc["offset" + name], doc["client" + name]);
          }
          return value === undefined ? jQuery.css(elem, type, extra) : jQuery.style(elem, type, value, extra);
        }, type, chainable ? margin : undefined, chainable, null);
      };
    });
  });
  jQuery.fn.size = function() {
    return this.length;
  };
  jQuery.fn.andSelf = jQuery.fn.addBack;
  if (typeof define === "function" && define.amd) {
    define("1", [], function() {
      return jQuery;
    });
  }
  var _jQuery = window.jQuery,
      _$ = window.$;
  jQuery.noConflict = function(deep) {
    if (window.$ === jQuery) {
      window.$ = _$;
    }
    if (deep && window.jQuery === jQuery) {
      window.jQuery = _jQuery;
    }
    return jQuery;
  };
  if (typeof noGlobal === strundefined) {
    window.jQuery = window.$ = jQuery;
  }
  return jQuery;
}));

_removeDefine();
})();
})
(function(factory) {
  if (typeof define == 'function' && define.amd)
    define([], factory);
  else
    factory();
});
//# sourceMappingURL=index.js.map