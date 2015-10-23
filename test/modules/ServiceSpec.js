define(["DataService"], function (dataService) {

    describe("DataService", function () {

        beforeEach(function () {
            spyOn(dataService, "processData").and.callThrough();
        });

        describe('When json file contains an empty object', function () {
            it('should data object be empty', function () {
                var input = '{}';
                var result;

                result = dataService.processData(input);
                expect(result).toEqual({});
            });
        });

        describe('When json file contains valid JSON of some object', function () {
            it('should has it in data object', function () {
                var input = '{"checklist": {"questions": [{"id": 0,"name": "Кормили ли Вы когда-либо каких-нибудь животных?", "availableAnswersIds": [ 0, 1, 2 ]}]}}';
                var result;

                result = dataService.processData(input);
                expect(dataService.data.hasOwnProperty('checklist')).toBe(true);
            });
        });

        describe('When json file contains not valid JSON', function () {
            it('should has empty data object', function () {
                var input = '';
                var result;

                expect(function () {
                    dataService.processData();
                }).toThrowError("JSON.parse");
                expect(result).toBeUndefined();
            });
        });
    });
});