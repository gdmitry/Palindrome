// https://iterativo.wordpress.com/2012/03/06/unit-testing-javascript-modules-using-requirejs-and-jasmine/
// http://blog.pluralsight.com/6-examples-of-hard-to-test-javascript

define(["LocalStorage"], function (localStorage) {

    xdescribe("LocalStorage", function () {

        describe('When retriveResults', function () {
            describe('and checkStorage is true', function () {
                beforeEach(function () {
                    spyOn(localStorage, "checkStorage").and.returnValue(true);
                });

                it("should retrive results if it was stored previously", function () {
                    var result;

                    spyOn(localStorage.localStorage, "getItem").and.returnValue('[{"question":{}, "answer":{}}]');
                    result = localStorage.retriveResults();
                    expect(localStorage.localStorage.getItem).toHaveBeenCalled();
                    expect(result).toEqual([{ question: {}, answer: {} }]);
                });

                it('should return empty array if it was not stored previously', function () {
                    var result;

                    spyOn(localStorage.localStorage, "getItem").and.returnValue(null);
                    result = localStorage.retriveResults();
                    expect(localStorage.localStorage.getItem).toHaveBeenCalled();
                    expect(result).toEqual([]);
                });

                it('should throw exception if JSON not valid', function () {
                    var result;

                    spyOn(localStorage.localStorage, "getItem").and.returnValue("{stub}");
                    expect(function () {
                        result = localStorage.retriveResults();
                    }).toThrowError("JSON.parse");
                    expect(localStorage.localStorage.getItem).toHaveBeenCalled();
                    expect(result).toBeUndefined();
                });

            });

            describe('and checkStorage is false', function () {
                var result;
                beforeEach(function () {
                    spyOn(localStorage, "checkStorage").and.returnValue(false);
                });

                it("should not retrive results", function () {
                    spyOn(localStorage.localStorage, "getItem");
                    result = localStorage.retriveResults();
                    expect(localStorage.localStorage.getItem).not.toHaveBeenCalled();
                });
            });
        });

        describe('When resetResults', function () {

            beforeEach(function () {
                spyOn(localStorage.localStorage, "removeItem").and.returnValue("{stub}");
            });

            it("should reset results if localStorage is enabled", function () {
                spyOn(localStorage, "checkStorage").and.returnValue(true);
                localStorage.resetResults();
                expect(localStorage.localStorage.removeItem).toHaveBeenCalled();
            });

            it('should not reset results if localStorage is disabled', function () {
                spyOn(localStorage, "checkStorage").and.returnValue(false);
                localStorage.resetResults();
                expect(localStorage.localStorage.removeItem).not.toHaveBeenCalled();
            });
        });

        describe('When storeResults', function () {

            beforeEach(function () {
                spyOn(LocalStorage.localStorage, "setItem");
            });

            describe('and checkStorage is true', function () {
                var input;

                beforeEach(function () {
                    spyOn(LocalStorage, "checkStorage").and.returnValue(true);
                });

                it("should store valid object for JSON", function () {
                    input = {
                        question: {
                            "id": 0,
                            "name": "Кормили ли Вы когда-либо каких-нибудь животных?",
                            "availableAnswersIds": [0, 1, 2]
                        },
                        answer: {
                            "id": 0,
                            "name": "Да, конечно.",
                            "nextQuestionId": 1
                        }
                    }

                    LocalStorage.storeResults(input);
                    expect(LocalStorage.localStorage.setItem).toHaveBeenCalled();
                });

                it('should throw cyclic object value if object contains cycles', function () {
                    input = {};
                    input.a = { b: input };

                    LocalStorage.storeResults();
                    expect(function () {
                        LocalStorage.storeResults(input);
                    }).toThrowError("cyclic object value");
                    expect(LocalStorage.localStorage.setItem).toHaveBeenCalled();
                });

            });

            describe('and checkStorage is false', function () {

                beforeEach(function () {
                    spyOn(LocalStorage, "checkStorage").and.returnValue(false);
                });

                it("should not store results", function () {
                    LocalStorage.storeResults();
                    expect(LocalStorage.localStorage.setItem).not.toHaveBeenCalled();
                });
            });
        });

    });
});