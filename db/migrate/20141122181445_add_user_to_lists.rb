class AddUserToLists < ActiveRecord::Migration
  def change
    change_table :lists do |t|
      t.integer :user
    end
  end
end
