'use strict'

function testPalyndrom(testString) {	
		var i, j;
		for (i = 0; i < testString.length; i++) {
			for (j = i+2; j < testString.length; j++) {
				checkIfPalyndrom(testString.substring(i, j+1));
			}
		}			
	};
	
	function checkIfPalyndrom(str) {	
		var i = 0,
			j = str.length-1;
		
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

   document.querySelectorAll('.sendButton')[0].addEventListener('click', function(e){
	   testPalyndrom(document.querySelectorAll('.input-field')[0].value);
   });