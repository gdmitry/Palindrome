define(function () {
    'use strict';

    var LocalStorage = function () {

        this.removeItem = function (item) {
            if (this.checkStorage()) {
                localStorage.removeItem('testResults');
            }
        };

        this.setItem = function (item, value) {
            if (this.checkStorage()) {
                localStorage.setItem(item, value);
            }
        };

        this.getItem = function (item) {
            if (this.checkStorage()) {
                return localStorage.getItem(item);
            }
        };

        this.checkStorage = function () {
            if (Modernizr.localstorage) {
                return true;
            } else {
                return false;
            }
        };
    };

    return new LocalStorage();

});