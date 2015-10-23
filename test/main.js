require.config({
    paths: {
        'text':
        '../dev/lib/text',
        'Model': '../dev/modules/Model',
        'DataService': '../dev/modules/DataService',
        'ViewModel': "../dev/modules/ViewModel",
        'LocalStorage': "../dev/modules/LocalStorage"
    }
});

require([
        './modules/ServiceSpec',
         './modules/ViewModelSpec',
         './modules/ModelSpec',
        './modules/LocalStorageSpec'
],
    function () {
        (typeof console !== 'undefined' && typeof console.log === "function") ? console.log("Jasmine started..") : "";
        jasmine.getEnv().execute();
    });