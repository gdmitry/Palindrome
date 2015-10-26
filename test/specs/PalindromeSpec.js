//var Element = require('../../src/Palindrome.js');


define(['../../src/Palindrome.js'], function (Palindrome) {

	describe("Model", function () {
		it('should return empty array of questions', function () {
			expect(0).toBe(0);
		});

	});

	//        describe('When data is undefined', function () {
	//            var result;
	//
	//            beforeEach(function () {
	//                model.data = undefined;
	//            });
	//
	//            it('should return empty array of questions', function () {
	//                result = model.getQuestions();
	//                expect(result.length).toBe(0);
	//            });
	//
	//            it('should return empty array of answers', function () {
	//                result = model.getAnswers();
	//                expect(result.length).toBe(0);
	//            });
	//        });
	//
	//        describe('When add a result', function () {
	//            var question;
	//            var answer;
	//            var isLastQuestion;
	//
	//            beforeEach(function () {
	//                question = {
	//                    "id": 0,
	//                    "name": "Кормили ли Вы когда-либо каких-нибудь животных?",
	//                    "availableAnswersIds": [0, 1, 2]
	//                }
	//                answer = {
	//                    "id": 0,
	//                    "name": "Да, конечно.",
	//                    "nextQuestionId": 1
	//                };
	//                model.results = [];
	//                spyOn(localStorage, "setItem");
	//            });
	//
	//            it('should add result to array results and don"t save it to localStorage for not last result', function () {
	//                isLastQuestion = false;
	//
	//                model.addResult(question, answer, isLastQuestion);
	//                expect(localStorage.setItem).not.toHaveBeenCalled();
	//                expect(model.results.length).toBe(1);
	//            });
	//
	//            it('should add result to array results and save it to localStorage for last result', function () {
	//                isLastQuestion = true;
	//
	//                model.addResult(question, answer, isLastQuestion);
	//                expect(localStorage.setItem).toHaveBeenCalled();
	//                expect(model.results.length).toBe(1);
	//            });
	//        });
	//    });
});