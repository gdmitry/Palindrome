// http://jsfiddle.net/rniemeyer/FvZXj/
// http://jsfiddle.net/rniemeyer/8eeUR/

define(["./Model"], function (model) {
    'use strict';
 

    var ViewModel = function () { 
		var self = this;
		this.testString = ko.observable();
//        this.answers = ko.computed(function () {
//            var output = [];
//            var answers = this.currentQuestion().availableAnswersIds;
//
//            answers.forEach(function (answerId) {
//                this.allAnswers.some(function (answer) {
//                    if (answer.id === answerId) {
//                        output.push(answer);
//                        return true;
//                    }
//                }, this);
//            }, this);
//
//            return output;
//        }, this);

     
//        this.results = ko.observableArray(model.results);

        this.testForPalyndrom = function() {
		 	console.log("here",this.testString());
			model.testPalyndrom(this.testString());
		};      
    };

    return new ViewModel();

});