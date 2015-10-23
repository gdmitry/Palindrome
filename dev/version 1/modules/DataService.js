define(['text!json/data.json'], function (textData) {
    'use strict';

    var DataService = function () {

        this.processData = function (textData) {
            var data;
            try {
                data = JSON.parse(textData);
            } catch (e) {
                throw Error("JSON.parse");
            }
            return data;
        }
        this.data = this.processData(textData);
    }

    return new DataService();
});
