class CreateUsers < ActiveRecord::Migration
  def change
    create_table :users do |t|
      t.string :lists
    end
  end
end
