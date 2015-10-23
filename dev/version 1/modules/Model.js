define(['./DataService', './LocalStorage'], function (dataService, localStorage) {
    'use strict';

    var model = {
		testPalyndrom: testPalyndrom
    };

    return model;
	
	function testPalyndrom(testString) {
		testString = 'yabxyzyxba1';
		var k, i, j, l;
		
		for (k = 0; k < testString.length; k++) {
			for (l = k+2; l < testString.length; l++) {
				checkPalyndrom(k, l, testString);
//				console.log(k,l);
			}
		}
			
	};
	
	function checkPalyndrom(i, j, str) {	
		var p = str.substring(i, j+1);
//		console.log("+++", p);
		
		while ((str[i] === str[j]) && (i !== j)) {
				i++;
				j--;
		}			
		if (i === j) {
			console.log("+++", p);
		}
	}
	
});