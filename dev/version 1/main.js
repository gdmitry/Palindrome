require.config({
    paths: {
        'text':
        'lib/text'
    }
});

requirejs(["./modules/ViewModel"], function (viewmodel) {
    ko.applyBindings(viewmodel);
});

